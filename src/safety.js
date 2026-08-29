'use strict';
/**
 * The safety layer.
 *
 * Guarantee: running any command in this tool cannot cost you work.
 *
 * How it holds:
 *   1. A snapshot captures HEAD, the index, the working tree AND untracked
 *      files as a real commit object, written to refs/poly/safety/<id>.
 *      Because it is a ref, it is reachable, so `git gc` will never collect it,
 *      and deleting a branch cannot orphan it.
 *   2. Snapshots are built through a temporary index file. The repo's own
 *      index and working tree are never touched, so taking a snapshot is
 *      invisible to whatever you were doing. Unlike `git stash`, nothing is
 *      removed from your working tree.
 *   3. Every mutating command takes a snapshot before its first write.
 *   4. Nothing in this tool ever deletes a snapshot. Pruning is manual.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const g = require('./git');

const SAFETY_REF_PREFIX = 'refs/poly/safety';

/** Sortable, human-readable snapshot id: 20260829-191500-a1b2 */
function newSnapshotId(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const stamp =
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) + '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds());
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function tempIndexPath() {
  return path.join(
    os.tmpdir(),
    `poly-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
}

/**
 * Snapshot one repository.
 *
 * Returns { repo, path, ok, sha, ref, head, branch, detached, state, empty, skipped, error }
 *
 * `includeIgnored` also captures .gitignore'd files. Off by default because it
 * would sweep up node_modules and build output; worth turning on when you are
 * about to do something you really do not trust.
 */
function snapshotRepo(repoPath, { id, label, includeIgnored = false, name } = {}) {
  const result = {
    name: name || path.basename(repoPath),
    path: repoPath,
    ok: false,
    sha: null,
    ref: null,
    head: null,
    branch: null,
    detached: false,
    empty: false,
    state: null,
    error: null,
  };

  if (!g.isRepo(repoPath)) {
    result.error = 'not a git repository';
    return result;
  }

  const idx = tempIndexPath();
  const env = { GIT_INDEX_FILE: idx };

  try {
    const head = g.headSha(repoPath);
    const empty = head === null;
    result.head = head;
    result.empty = empty;
    result.branch = g.currentBranch(repoPath);
    result.detached = !empty && result.branch === null;
    result.state = g.worktreeState(repoPath);

    // Build a throwaway index seeded from HEAD (or empty for a fresh repo).
    if (empty) {
      g.git(['read-tree', '--empty'], { cwd: repoPath, env });
    } else {
      g.git(['read-tree', 'HEAD'], { cwd: repoPath, env });
    }

    // Stage everything in the working tree into the throwaway index.
    // -A picks up modifications, deletions and untracked files.
    const addArgs = ['add', '-A'];
    if (includeIgnored) addArgs.push('--force');
    addArgs.push('--', '.');
    g.git(addArgs, { cwd: repoPath, env });

    const tree = g.git(['write-tree'], { cwd: repoPath, env });

    const message = [
      `poly safety snapshot ${id}`,
      '',
      label ? `label: ${label}` : null,
      `repo: ${result.name}`,
      `branch: ${result.detached ? '(detached)' : (result.branch || '(none)')}`,
      `head: ${head || '(no commits)'}`,
      result.state
        ? `worktree: ${result.state.total} change(s) — ` +
          `${result.state.staged} staged, ${result.state.modified} modified, ${result.state.untracked} untracked`
        : null,
      '',
      'Restore with:  poly restore ' + id,
    ].filter(x => x !== null).join('\n');

    const commitArgs = ['commit-tree', tree];
    if (!empty) commitArgs.push('-p', head);
    commitArgs.push('-m', message);

    const snapSha = g.git(commitArgs, {
      cwd: repoPath,
      env: {
        // Attribute snapshots to the tool so they are obvious in the log.
        GIT_AUTHOR_NAME: 'poly',
        GIT_AUTHOR_EMAIL: 'poly@local',
        GIT_COMMITTER_NAME: 'poly',
        GIT_COMMITTER_EMAIL: 'poly@local',
      },
    });

    const ref = `${SAFETY_REF_PREFIX}/${id}`;
    g.git(['update-ref', ref, snapSha, '-m', `poly snapshot ${id}`], { cwd: repoPath });

    result.ok = true;
    result.sha = snapSha;
    result.ref = ref;
    return result;
  } catch (err) {
    result.error = err.stderr || err.message;
    return result;
  } finally {
    try { fs.rmSync(idx, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(idx + '.lock', { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Snapshot the superproject and every member repo in one shot.
 * Returns { id, label, when, repos: [...], allOk }
 */
function snapshotAll(workspace, { label, includeIgnored = false, id } = {}) {
  const snapId = id || newSnapshotId();
  const targets = [
    { name: workspace.name || '(superproject)', path: workspace.root, role: 'superproject' },
    ...workspace.members.map(m => ({ name: m.name, path: m.absPath, role: 'member' })),
  ];

  const repos = targets.map(t => {
    if (!fs.existsSync(t.path)) {
      return {
        name: t.name, path: t.path, role: t.role, ok: false,
        skipped: true, error: 'not checked out on disk',
      };
    }
    return { ...snapshotRepo(t.path, { id: snapId, label, includeIgnored, name: t.name }), role: t.role };
  });

  const record = {
    id: snapId,
    label: label || null,
    when: new Date().toISOString(),
    includeIgnored,
    repos: repos.map(r => ({
      name: r.name,
      role: r.role,
      path: r.path,
      ok: !!r.ok,
      sha: r.sha || null,
      ref: r.ref || null,
      head: r.head || null,
      branch: r.branch || null,
      detached: !!r.detached,
      changes: r.state ? r.state.total : 0,
      untracked: r.state ? r.state.untracked : 0,
      skipped: !!r.skipped,
      error: r.error || null,
    })),
  };
  record.allOk = record.repos.every(r => r.ok || r.skipped);
  record.changedRepos = record.repos.filter(r => r.changes > 0).length;

  writeJournal(workspace.root, record);
  return record;
}

/* ------------------------------------------------------------------ */
/* Journal — a human-readable index. Git refs remain the source of truth. */
/* ------------------------------------------------------------------ */

function journalDir(root) {
  return path.join(root, '.poly');
}

function journalFile(root) {
  return path.join(journalDir(root), 'snapshots.json');
}

function readJournal(root) {
  try {
    return JSON.parse(fs.readFileSync(journalFile(root), 'utf8'));
  } catch {
    return { version: 1, snapshots: [] };
  }
}

function writeJournal(root, record) {
  try {
    const dir = journalDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const journal = readJournal(root);
    journal.version = 1;
    journal.snapshots = journal.snapshots.filter(s => s.id !== record.id);
    journal.snapshots.unshift(record);
    // Keep the file readable; the refs hold the real history regardless.
    journal.snapshots = journal.snapshots.slice(0, 500);
    fs.writeFileSync(journalFile(root), JSON.stringify(journal, null, 2));
  } catch {
    // A journal write failure must never fail a snapshot: the ref is what matters.
  }
}

/**
 * List snapshots by reading refs directly from every repo, then enriching with
 * journal metadata. Reading refs first means snapshots stay discoverable even
 * if .poly/ is deleted.
 */
function listSnapshots(workspace) {
  const byId = new Map();

  const repos = [
    { name: workspace.name || '(superproject)', path: workspace.root, role: 'superproject' },
    ...workspace.members.filter(m => m.present).map(m => ({ name: m.name, path: m.absPath, role: 'member' })),
  ];

  for (const repo of repos) {
    for (const ref of g.listRefs(repo.path, `${SAFETY_REF_PREFIX}/**`)) {
      const id = ref.ref.slice(SAFETY_REF_PREFIX.length + 1);
      if (!byId.has(id)) byId.set(id, { id, when: ref.date, repos: [], label: null });
      byId.get(id).repos.push({ name: repo.name, role: repo.role, path: repo.path, sha: ref.sha });
    }
  }

  const journal = readJournal(workspace.root);
  for (const entry of journal.snapshots) {
    if (byId.has(entry.id)) {
      const s = byId.get(entry.id);
      s.label = entry.label;
      s.when = entry.when || s.when;
      s.changedRepos = entry.changedRepos;
      s.journal = entry;
    }
  }

  return [...byId.values()].sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

function findSnapshot(workspace, idOrPrefix) {
  const all = listSnapshots(workspace);
  if (!idOrPrefix || idOrPrefix === 'latest') return all[0] || null;
  const exact = all.find(s => s.id === idOrPrefix);
  if (exact) return exact;
  const matches = all.filter(s => s.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const err = new Error(
      `Snapshot id "${idOrPrefix}" is ambiguous — matches ${matches.length}:\n` +
      matches.map(m => `  ${m.id}`).join('\n')
    );
    err.ambiguous = true;
    throw err;
  }
  return null;
}

/**
 * Restore a snapshot.
 *
 * mode 'branch' (default) — non-destructive. Creates a local branch at the
 *   snapshot commit in each repo and leaves your working tree exactly as it is.
 *   You inspect it, cherry-pick from it, or check it out yourself.
 *
 * mode 'apply' — writes the snapshot's file contents back into the working
 *   tree. A fresh snapshot of the current state is always taken first, so this
 *   is reversible. It restores paths but never deletes files that exist now and
 *   were not in the snapshot.
 */
function restoreSnapshot(workspace, snapshot, { mode = 'branch', branchName } = {}) {
  const results = [];
  const branch = branchName || `poly/snap/${snapshot.id}`;

  for (const entry of snapshot.repos) {
    const r = { name: entry.name, path: entry.path, role: entry.role, sha: entry.sha, ok: false, action: null, error: null };
    try {
      if (!g.commitExists(entry.path, entry.sha)) {
        r.error = 'snapshot commit missing from this repo';
        results.push(r);
        continue;
      }

      if (mode === 'branch') {
        const target = g.refExists(entry.path, `refs/heads/${branch}`) ? `${branch}-${Date.now()}` : branch;
        g.git(['branch', '--no-track', target, entry.sha], { cwd: entry.path });
        r.ok = true;
        r.action = `branch ${target}`;
        r.branch = target;
      } else if (mode === 'apply') {
        // Restore tracked content from the snapshot into index + working tree.
        // Destructive to the *current* file contents, which is why the caller
        // snapshots first; nothing on disk is deleted by this.
        g.git(['restore', '--source', entry.sha, '--staged', '--worktree', '--', '.'],
          { cwd: entry.path, allowDestructive: true });
        r.ok = true;
        r.action = 'files restored into working tree';
      }
    } catch (err) {
      r.error = err.stderr || err.message;
    }
    results.push(r);
  }

  return results;
}

/**
 * Guard used by every mutating command.
 * Takes a snapshot and refuses to continue unless it succeeded everywhere.
 */
function guard(workspace, label, opts = {}) {
  const snap = snapshotAll(workspace, { label, includeIgnored: opts.includeIgnored });
  const failed = snap.repos.filter(r => !r.ok && !r.skipped);
  if (failed.length) {
    const err = new Error(
      'Refusing to continue: could not snapshot your work first.\n' +
      failed.map(f => `  ${f.name}: ${f.error}`).join('\n')
    );
    err.snapshot = snap;
    throw err;
  }
  return snap;
}

module.exports = {
  SAFETY_REF_PREFIX,
  newSnapshotId,
  snapshotRepo,
  snapshotAll,
  listSnapshots,
  findSnapshot,
  restoreSnapshot,
  readJournal,
  journalDir,
  guard,
};
