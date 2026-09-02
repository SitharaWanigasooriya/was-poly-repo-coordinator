'use strict';
/**
 * poly pr — open the pull requests for a change set.
 *
 * For the superproject and every member repo on a feature branch, open a PR
 * from the current branch into its protected branch. It never pushes for you:
 * a branch that is not on its remote, or is ahead of it, is refused with the
 * exact push command to run. Nothing is written to any local repository.
 *
 * planPullRequests() is pure local git + the manifest — no network. Only
 * openPullRequests() talks to GitHub, through src/github.js.
 */

const path = require('path');
const g = require('./git');
const github = require('./github');
const cs = require('./changeset');

/**
 * Work out, per repo, what PR would be opened and why it can't be.
 * Local only. Returns { targets, changeset }.
 *
 *   target = { name, role, path, absPath, branch, base, head, gh, blocker }
 * `blocker` is a string when this repo is skipped, otherwise null.
 */
function planPullRequests(ws, { memberNames = [], base = null, membersOnly = false, changesetId = null } = {}) {
  let changeset = null;
  if (changesetId) {
    changeset = cs.read(ws.root, changesetId);
    if (!changeset) {
      const err = new Error(`No change set matching "${changesetId}".`);
      err.userFacing = true;
      throw err;
    }
  }

  const unknown = memberNames.filter(n => !ws.members.some(mem => mem.name === n));
  if (unknown.length) {
    const err = new Error(`Unknown member(s): ${unknown.join(', ')}`);
    err.userFacing = true;
    throw err;
  }

  const defaults = ws.manifest.defaults || {};
  const repos = [];
  if (!membersOnly) {
    repos.push({
      name: ws.name,
      role: 'superproject',
      path: '.',
      absPath: ws.root,
      protectedBranch: defaults.protectedBranch || 'main',
      remote: defaults.remote || 'origin',
      url: null,
      present: true,
    });
  }
  for (const mem of ws.members) repos.push({ ...mem, role: 'member' });

  let wanted = null;
  if (changeset) wanted = new Set(changeset.members.map(e => e.name));
  else if (memberNames.length) wanted = new Set(memberNames);

  const targets = [];
  for (const repo of repos) {
    if (repo.role === 'member' && wanted && !wanted.has(repo.name)) continue;

    const t = {
      name: repo.name,
      role: repo.role,
      path: repo.path,
      absPath: repo.absPath,
      branch: null,
      base: base || repo.protectedBranch,
      head: null,
      gh: null,
      blocker: null,
    };
    const pushHint = repo.role === 'superproject' ? '' : ` -C ${repo.path}`;

    if (repo.role === 'member' && !repo.present) {
      t.blocker = `not checked out — run: git submodule update --init -- ${repo.path}`;
      targets.push(t);
      continue;
    }

    const cwd = repo.absPath;
    if (g.isEmptyRepo(cwd)) { t.blocker = 'no commits yet'; targets.push(t); continue; }
    if (g.isDetached(cwd)) { t.blocker = 'detached HEAD — check out the feature branch first'; targets.push(t); continue; }

    const branch = g.currentBranch(cwd);
    t.branch = branch;
    if (branch === t.base) {
      t.blocker = `on ${branch} — check out a feature branch to open a PR from`;
      targets.push(t);
      continue;
    }

    const head = g.headSha(cwd);
    const remoteSha = g.resolveRef(cwd, `refs/remotes/${repo.remote}/${branch}`);
    if (!remoteSha || !g.isAncestor(cwd, head, remoteSha)) {
      t.blocker = `${branch} is not pushed — run: git${pushHint} push -u ${repo.remote} ${branch}`;
      targets.push(t);
      continue;
    }
    t.head = head;

    // poly.json is the policy truth about a member's identity; fall back to the
    // live remote URL (the only source the superproject has).
    const gh = github.parseGithubRepo(repo.url) || github.parseGithubRepo(g.remoteUrl(cwd, repo.remote));
    if (!gh) {
      t.blocker = `${repo.remote} is not a github.com remote`;
      targets.push(t);
      continue;
    }
    t.gh = gh;
    targets.push(t);
  }

  return { targets, changeset };
}

/**
 * Open a PR for every non-blocked target. Returns one result row per target:
 *   { ...target, status: 'created' | 'exists' | 'error' | 'blocked', number?, url?, message? }
 *
 * `auth` / `transport` are passed straight through to src/github.js (transport
 * is for tests). An already-open PR is reported, not re-created.
 */
async function openPullRequests(ws, targets, { title = null, body = null, draft = false, auth, transport } = {}) {
  const results = [];

  for (const t of targets) {
    if (t.blocker) { results.push({ ...t, status: 'blocked', message: t.blocker }); continue; }

    const cwd = t.role === 'superproject' ? ws.root : path.resolve(ws.root, t.path);
    const params = { owner: t.gh.owner, repo: t.gh.repo, head: t.branch, base: t.base };

    const existing = await github.findOpenPr(params, auth, transport);
    if (existing) {
      results.push({ ...t, status: 'exists', number: existing.number, url: existing.url });
      continue;
    }

    const prTitle = title || (g.commitMeta(cwd, t.head) || {}).subject || t.branch;
    const res = await github.createPullRequest({ ...params, title: prTitle, body, draft }, auth, transport);
    if (res.ok) {
      results.push({ ...t, status: res.status, number: res.number, url: res.url });
    } else {
      results.push({ ...t, status: 'error', message: res.error });
    }
  }

  return results;
}

module.exports = { planPullRequests, openPullRequests };
