'use strict';
/**
 * ChangeSet — one logical change spread across several member repos.
 *
 * Phase 2 of the solution definition. A change set records which members take
 * part, which branch each carries the work on, and what pointer each was at
 * when the set was opened — so you can watch the pieces land and know when the
 * whole thing is safe to bump in the superproject.
 *
 * Storage is `.poly/changesets/<id>.json` at the superproject root. That
 * directory is gitignored, exactly like `.poly/snapshots.json`: a change set is
 * local working state, not something to commit. `poly land` reads one to decide
 * scope and marks it landed when the superproject commit is made.
 */

const fs = require('fs');
const path = require('path');
const g = require('./git');
const policy = require('./policy');
const safety = require('./safety');

function dir(root) {
  return path.join(root, '.poly', 'changesets');
}

function file(root, id) {
  return path.join(dir(root), `${id}.json`);
}

/** Current pointer for a member path, from the index. */
function pointerOf(root, memberPath) {
  const hit = g.gitlinksInIndex(root).find(l => l.path === memberPath);
  return hit ? hit.sha : null;
}

/**
 * Open a change set. `memberNames` empty ⇒ auto-select every member that looks
 * like it is carrying work: on a branch other than its protected one, or with a
 * dirty worktree.
 */
function create(workspace, { title, memberNames = [] } = {}) {
  if (!title || !String(title).trim()) {
    const err = new Error('A change set needs a title.  poly changeset new "what this change is"');
    err.userFacing = true;
    throw err;
  }

  let members = workspace.members;
  if (memberNames.length) {
    const unknown = memberNames.filter(n => !members.some(m => m.name === n));
    if (unknown.length) {
      const err = new Error(`Unknown member(s): ${unknown.join(', ')}`);
      err.userFacing = true;
      throw err;
    }
    members = members.filter(m => memberNames.includes(m.name));
  } else {
    members = members.filter(m => {
      if (!m.present) return false;
      const branch = g.currentBranch(m.absPath);
      const dirty = !g.worktreeState(m.absPath).clean;
      return dirty || (branch && branch !== m.protectedBranch);
    });
  }

  const cs = {
    id: safety.newSnapshotId(),
    title: String(title).trim(),
    created: new Date().toISOString(),
    status: 'open',
    members: members.map(m => ({
      name: m.name,
      path: m.path,
      branch: m.present ? g.currentBranch(m.absPath) : null,
      pointerAtCreate: pointerOf(workspace.root, m.path),
      merged: false,
      landedSha: null,
    })),
    landedAt: null,
    superprojectCommit: null,
  };

  write(workspace.root, cs);
  return cs;
}

function write(root, cs) {
  fs.mkdirSync(dir(root), { recursive: true });
  fs.writeFileSync(file(root, cs.id), JSON.stringify(cs, null, 2) + '\n');
  return file(root, cs.id);
}

function list(root) {
  let names;
  try {
    names = fs.readdirSync(dir(root)).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir(root), n), 'utf8')));
    } catch { /* skip an unreadable file */ }
  }
  return out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

function read(root, idOrPrefix) {
  if (!idOrPrefix) return null;
  const exact = file(root, idOrPrefix);
  if (fs.existsSync(exact)) {
    return JSON.parse(fs.readFileSync(exact, 'utf8'));
  }
  const matches = list(root).filter(cs => cs.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const err = new Error(
      `Change set "${idOrPrefix}" is ambiguous — matches ${matches.length}:\n` +
      matches.map(m => `  ${m.id}  ${m.title}`).join('\n')
    );
    err.userFacing = true;
    throw err;
  }
  return null;
}

/**
 * Recompute the merge state of every member against its protected branch.
 * Returns the change set (mutated) plus a list of what changed.
 */
function refresh(workspace, cs) {
  const byName = new Map(workspace.members.map(m => [m.name, m]));
  const changes = [];

  for (const entry of cs.members) {
    const member = byName.get(entry.name);
    if (!member || !member.present) continue;

    const protectedRef = policy.resolveProtectedRef(member.absPath, member);
    if (!protectedRef) continue;

    // The commit to judge: the branch tip if we know the branch, else the
    // pointer the set opened at.
    let candidate = null;
    if (entry.branch) candidate = g.resolveRef(member.absPath, entry.branch);
    if (!candidate) candidate = entry.pointerAtCreate;

    const merged = !!candidate && g.isAncestor(member.absPath, candidate, protectedRef.sha);
    const landedSha = merged ? protectedRef.sha : null;

    if (merged !== entry.merged) {
      changes.push({ name: entry.name, from: entry.merged, to: merged });
    }
    entry.merged = merged;
    entry.landedSha = landedSha;
  }

  if (cs.members.length && cs.members.every(e => e.merged) && cs.status === 'open') {
    cs.status = 'ready';
  }

  write(workspace.root, cs);
  return { cs, changes };
}

function markLanded(root, cs, superprojectCommit) {
  cs.status = 'landed';
  cs.landedAt = new Date().toISOString();
  cs.superprojectCommit = superprojectCommit || null;
  write(root, cs);
  return cs;
}

module.exports = { dir, file, create, write, list, read, refresh, markLanded };
