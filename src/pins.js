'use strict';
/**
 * Durable pins (invariant I2).
 *
 * Reachability from a protected branch is not durability: the branch can be
 * reset and history can be rewritten. A pin is a ref that keeps a specific
 * commit permanently reachable in the member repo, so `git gc` will never
 * collect it no matter what happens to the branch it came from.
 *
 * A pin is just `refs/poly/pins/<member>/<shortsha>` pointing at that commit.
 * `src/policy.js` already recognises these — see gate1 check 4. This module is
 * the writer.
 *
 * Nothing here ever deletes a pin. Like snapshots, pruning is manual and is
 * plain git, deliberately outside the tool.
 */

const g = require('./git');

const PIN_REF_PREFIX = 'refs/poly/pins';

/** Slugify a member name so it is safe inside a ref path. */
function slug(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'member';
}

function pinRef(memberName, sha) {
  return `${PIN_REF_PREFIX}/${slug(memberName)}/${String(sha).slice(0, 12)}`;
}

/**
 * Pin one commit in one member repo.
 * Returns { ok, ref, sha, already, pushed, error }.
 */
function pin(memberAbsPath, { name, sha, push = false, remote = 'origin' } = {}) {
  const out = { name, ok: false, ref: null, sha: sha || null, already: false, pushed: false, error: null };

  if (!g.isRepo(memberAbsPath)) {
    out.error = 'not a git repository';
    return out;
  }
  if (!sha) {
    out.error = 'no commit to pin';
    return out;
  }
  if (!g.commitExists(memberAbsPath, sha)) {
    out.error = `commit ${String(sha).slice(0, 10)} is not in this repo`;
    return out;
  }

  const ref = pinRef(name, sha);
  out.ref = ref;

  const existing = g.resolveRef(memberAbsPath, ref);
  if (existing === sha) {
    out.ok = true;
    out.already = true;
  } else {
    const r = g.tryGit(['update-ref', ref, sha], { cwd: memberAbsPath });
    if (!r.ok) {
      out.error = r.err.split('\n')[0];
      return out;
    }
    out.ok = true;
  }

  if (push) {
    const r = g.tryGit(['push', remote, `${ref}:${ref}`], { cwd: memberAbsPath, timeout: 180000 });
    if (r.ok) out.pushed = true;
    else out.error = `pinned locally, but push failed: ${r.err.split('\n')[0]}`;
  }

  return out;
}

/** Every pin ref currently in a member repo: [{ ref, sha, date }]. */
function listPins(memberAbsPath) {
  return g.listRefs(memberAbsPath, `${PIN_REF_PREFIX}/**`);
}

/** True when `sha` has a pin ref in the member repo. */
function isPinned(memberAbsPath, sha) {
  if (!sha) return false;
  return listPins(memberAbsPath).some(p => p.sha === sha);
}

/**
 * The gitlink each member is pointed at right now.
 * `treeish` — 'INDEX' (default, what you are about to commit) or 'HEAD'.
 */
function pointerFor(workspace, member, treeish = 'INDEX') {
  const links = treeish === 'HEAD'
    ? g.gitlinksInTree(workspace.root, 'HEAD')
    : g.gitlinksInIndex(workspace.root);
  const hit = links.find(l => l.path === member.path);
  return hit ? hit.sha : null;
}

/**
 * Pin the current pointer of every named member (or all present members with a
 * recorded pointer). Returns [{ name, ok, ref, sha, already, pushed, error, skipped }].
 */
function pinAll(workspace, { members, treeish = 'INDEX', push = false } = {}) {
  const targets = (members && members.length)
    ? workspace.members.filter(m => members.includes(m.name))
    : workspace.members;

  return targets.map(member => {
    if (!member.present) {
      return { name: member.name, ok: false, skipped: true, error: 'not checked out' };
    }
    const sha = pointerFor(workspace, member, treeish);
    if (!sha) {
      return { name: member.name, ok: false, skipped: true, error: 'no pointer recorded' };
    }
    return { ...pin(member.absPath, { name: member.name, sha, push, remote: member.remote }), skipped: false };
  });
}

/** Coverage summary for status/doctor: { pinned, total }. */
function coverage(workspace, treeish = 'INDEX') {
  let pinned = 0, total = 0;
  for (const member of workspace.members) {
    if (!member.present) continue;
    const sha = pointerFor(workspace, member, treeish);
    if (!sha) continue;
    total++;
    if (isPinned(member.absPath, sha)) pinned++;
  }
  return { pinned, total };
}

module.exports = {
  PIN_REF_PREFIX,
  pinRef,
  pin,
  pinAll,
  listPins,
  isPinned,
  pointerFor,
  coverage,
};
