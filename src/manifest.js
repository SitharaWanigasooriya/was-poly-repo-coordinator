'use strict';
/**
 * L0 — the manifest, and the workspace model derived from it.
 *
 * .gitmodules stays the Git-level truth about where submodules live.
 * poly.json is the policy truth: which branch is protected, what depends on
 * what, which repos take part in a fan-out. A doctor check enforces that the
 * two agree (invariant I6).
 */

const fs = require('fs');
const path = require('path');
const g = require('./git');

const MANIFEST_NAME = 'poly.json';

const DEFAULT_MANIFEST = {
  version: 1,
  superproject: {
    name: null,
    protectedBranches: ['main'],
  },
  defaults: {
    protectedBranch: 'main',
    remote: 'origin',
  },
  members: [],
  policy: {
    // Phase 1 is reporting-only: nothing here blocks by default.
    blockPointerRegression: true,
    requirePins: false,
    requireMergedPointers: true,
    // I3 (review integrity) is opt-in and only runs with `poly check --online`.
    // Even then it reports rather than blocks until this is set true.
    requireReviewedPointers: false,
  },
};

function manifestPath(root) {
  return path.join(root, MANIFEST_NAME);
}

function exists(root) {
  return fs.existsSync(manifestPath(root));
}

function read(root) {
  const file = manifestPath(root);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${MANIFEST_NAME} is not valid JSON: ${err.message}\n` +
      `  Fix the file, or delete it and run "poly init" again.`
    );
  }
  return normalise(parsed);
}

function normalise(m) {
  const out = {
    ...DEFAULT_MANIFEST,
    ...m,
    superproject: { ...DEFAULT_MANIFEST.superproject, ...(m.superproject || {}) },
    defaults: { ...DEFAULT_MANIFEST.defaults, ...(m.defaults || {}) },
    policy: { ...DEFAULT_MANIFEST.policy, ...(m.policy || {}) },
    members: (m.members || []).map(mem => ({
      name: mem.name || path.basename(mem.path || ''),
      path: (mem.path || '').replace(/\\/g, '/'),
      url: mem.url || null,
      protectedBranch: mem.protectedBranch || (m.defaults && m.defaults.protectedBranch) || 'main',
      remote: mem.remote || (m.defaults && m.defaults.remote) || 'origin',
      dependsOn: mem.dependsOn || [],
      participatesIn: mem.participatesIn || ['*'],
    })),
  };
  return out;
}

function write(root, manifest) {
  fs.writeFileSync(manifestPath(root), JSON.stringify(manifest, null, 2) + '\n');
  return manifestPath(root);
}

/**
 * Build a manifest by reading .gitmodules and the index. This is what
 * `poly init` writes, so nobody has to author one by hand.
 */
function discover(root) {
  const manifest = JSON.parse(JSON.stringify(DEFAULT_MANIFEST));
  manifest.superproject.name = path.basename(root);

  const headBranch = g.currentBranch(root);
  if (headBranch) manifest.superproject.protectedBranches = [headBranch];
  manifest.defaults.protectedBranch = headBranch || 'main';

  const modules = g.parseGitmodules(root);
  const links = new Map(g.gitlinksInIndex(root).map(l => [l.path, l.sha]));

  // `git submodule add` names a submodule after its path, so the recorded name
  // is usually "libs/api". The short basename is what people actually type, so
  // prefer it — unless two members would end up sharing one.
  const basenames = new Map();
  for (const mod of modules) {
    if (!mod.path) continue;
    const base = path.basename(mod.path);
    basenames.set(base, (basenames.get(base) || 0) + 1);
  }
  const shortName = p => {
    const base = path.basename(p);
    return basenames.get(base) === 1 ? base : p.replace(/\\/g, '/');
  };

  for (const mod of modules) {
    if (!mod.path) continue;
    const abs = path.join(root, mod.path);
    const present = g.isRepo(abs);
    manifest.members.push({
      name: shortName(mod.path),
      path: mod.path.replace(/\\/g, '/'),
      url: mod.url || (present ? g.remoteUrl(abs) : null),
      protectedBranch: mod.branch || (present ? (g.currentBranch(abs) || manifest.defaults.protectedBranch) : manifest.defaults.protectedBranch),
      remote: 'origin',
      dependsOn: [],
      participatesIn: ['*'],
    });
  }

  // Gitlinks in the index that .gitmodules never mentions are real and common:
  // record them so status/doctor can flag the inconsistency (I6).
  for (const [p] of links) {
    if (!manifest.members.some(m => m.path === p)) {
      manifest.members.push({
        name: path.basename(p),
        path: p.replace(/\\/g, '/'),
        url: null,
        protectedBranch: manifest.defaults.protectedBranch,
        remote: 'origin',
        dependsOn: [],
        participatesIn: ['*'],
        _orphanGitlink: true,
      });
    }
  }

  return manifest;
}

/**
 * Locate the superproject root by walking up from `start`, preferring a
 * directory that holds a manifest, then falling back to the git root.
 */
function findRoot(start) {
  let dir = path.resolve(start);
  const seen = new Set();
  while (!seen.has(dir)) {
    seen.add(dir);
    if (fs.existsSync(path.join(dir, MANIFEST_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const gitRoot = g.repoRoot(start);
  return gitRoot || null;
}

/**
 * The workspace: the manifest joined against what is actually on disk.
 * Every command takes this as its input.
 */
function loadWorkspace(start, { requireManifest = false } = {}) {
  const root = findRoot(start || process.cwd());
  if (!root) {
    const err = new Error(
      'Not inside a git repository.\n' +
      '  Run poly from your superproject (the repo that contains the submodules).'
    );
    err.userFacing = true;
    throw err;
  }

  const hasManifest = exists(root);
  if (requireManifest && !hasManifest) {
    const err = new Error(
      `No ${MANIFEST_NAME} found in ${root}\n` +
      `  Run "poly init" first — it reads .gitmodules and writes the manifest for you.`
    );
    err.userFacing = true;
    throw err;
  }

  const manifest = hasManifest ? read(root) : discover(root);

  const members = manifest.members.map(m => {
    const absPath = path.resolve(root, m.path);
    const present = fs.existsSync(absPath) && g.isRepo(absPath);
    return { ...m, absPath, present };
  });

  return {
    root,
    name: manifest.superproject.name || path.basename(root),
    manifest,
    hasManifest,
    members,
    isGitRepo: g.isRepo(root),
  };
}

module.exports = {
  MANIFEST_NAME,
  DEFAULT_MANIFEST,
  manifestPath,
  exists,
  read,
  write,
  discover,
  findRoot,
  loadWorkspace,
  normalise,
};
