'use strict';
/**
 * Tests for the properties the tool actually promises.
 *
 * No framework: real git repositories in a temp directory, real commands, real
 * assertions. If these pass, "your work cannot be lost" is a demonstrated
 * property rather than a claim.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const g = require('../src/git');
const safety = require('../src/safety');
const manifest = require('../src/manifest');
const policy = require('../src/policy');

/* ------------------------------------------------------------------ */
/* Tiny harness                                                        */
/* ------------------------------------------------------------------ */

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-test-'));
  try {
    fn(dir);
    passed++;
    console.log(`  \x1b[32m✓\x1b[39m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[39m ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows file locks */ }
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    // Quoted, so a difference in invisible characters — a stray CR, a trailing
    // space — cannot print as two identical-looking lines.
    const show = v => (typeof v === 'string' ? JSON.stringify(v) : String(v));
    throw new Error(`${message || 'not equal'}\n  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
  }
}

function assertThrows(fn, matcher, message) {
  let threw = null;
  try { fn(); } catch (err) { threw = err; }
  if (!threw) throw new Error(message || 'expected a throw, got none');
  if (matcher && !(threw instanceof matcher) && !String(threw.message).includes(matcher)) {
    throw new Error(`${message || 'wrong error'}: ${threw.message}`);
  }
  return threw;
}

/* ------------------------------------------------------------------ */
/* Git fixtures                                                        */
/* ------------------------------------------------------------------ */

function sh(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

function makeRepo(dir, { initialFile = 'README.md', content = 'hello\n' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  sh(['init', '-q', '-b', 'main'], dir);
  sh(['config', 'user.name', 'test'], dir);
  sh(['config', 'user.email', 'test@example.com'], dir);
  sh(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, initialFile), content);
  sh(['add', '-A'], dir);
  sh(['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

function fakeWorkspace(root, members = []) {
  return { root, name: path.basename(root), members, manifest: manifest.DEFAULT_MANIFEST, hasManifest: false };
}

/* ------------------------------------------------------------------ */
/* The safety guarantee                                                */
/* ------------------------------------------------------------------ */

console.log('\nsafety — snapshots');

test('captures modified, staged and untracked files', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));

  fs.writeFileSync(path.join(repo, 'README.md'), 'modified\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'precious\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
  sh(['add', 'staged.txt'], repo);

  const snap = safety.snapshotRepo(repo, { id: 'test-1' });
  assert(snap.ok, `snapshot failed: ${snap.error}`);

  const files = sh(['ls-tree', '-r', '--name-only', snap.sha], repo).split('\n');
  assert(files.includes('untracked.txt'), 'untracked file was not captured');
  assert(files.includes('staged.txt'), 'staged file was not captured');

  const readme = sh(['show', `${snap.sha}:README.md`], repo);
  assertEqual(readme, 'modified', 'modified content was not captured');

  const untracked = sh(['show', `${snap.sha}:untracked.txt`], repo);
  assertEqual(untracked, 'precious', 'untracked content was not captured');
});

test('leaves the working tree and index exactly as they were', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));

  fs.writeFileSync(path.join(repo, 'README.md'), 'modified\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'precious\n');
  sh(['add', 'README.md'], repo);

  const statusBefore = sh(['status', '--porcelain=v1', '-uall'], repo);
  const headBefore = sh(['rev-parse', 'HEAD'], repo);
  const branchBefore = sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo);

  safety.snapshotRepo(repo, { id: 'test-2' });

  assertEqual(sh(['status', '--porcelain=v1', '-uall'], repo), statusBefore, 'working tree changed');
  assertEqual(sh(['rev-parse', 'HEAD'], repo), headBefore, 'HEAD moved');
  assertEqual(sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo), branchBefore, 'branch changed');
  assert(fs.existsSync(path.join(repo, 'untracked.txt')), 'untracked file was removed');
  assertEqual(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'modified\n', 'file content changed');
});

test('survives branch deletion and aggressive gc', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));

  sh(['checkout', '-q', '-b', 'doomed'], repo);
  fs.writeFileSync(path.join(repo, 'work.txt'), 'valuable work\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-q', '-m', 'work in progress'], repo);
  fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'even more valuable\n');

  const snap = safety.snapshotRepo(repo, { id: 'test-3' });
  assert(snap.ok, 'snapshot failed');

  // Simulate the worst case: branch deleted, then git collects everything unreachable.
  sh(['checkout', '-q', 'main'], repo);
  sh(['branch', '-q', '-D', 'doomed'], repo);
  sh(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], repo);
  sh(['gc', '--prune=now', '--aggressive', '-q'], repo);

  assert(g.commitExists(repo, snap.sha), 'snapshot commit was garbage-collected');
  assertEqual(sh(['show', `${snap.sha}:work.txt`], repo), 'valuable work', 'committed work lost');
  assertEqual(sh(['show', `${snap.sha}:uncommitted.txt`], repo), 'even more valuable', 'uncommitted work lost');
});

test('handles a repository with no commits', tmp => {
  const repo = path.join(tmp, 'empty');
  fs.mkdirSync(repo, { recursive: true });
  sh(['init', '-q', '-b', 'main'], repo);
  sh(['config', 'user.name', 'test'], repo);
  sh(['config', 'user.email', 'test@example.com'], repo);
  fs.writeFileSync(path.join(repo, 'first.txt'), 'content\n');

  const snap = safety.snapshotRepo(repo, { id: 'test-4' });
  assert(snap.ok, `snapshot failed: ${snap.error}`);
  assert(snap.empty, 'should have detected an empty repo');
  assertEqual(sh(['show', `${snap.sha}:first.txt`], repo), 'content', 'content not captured');
});

test('captures a detached HEAD without attaching it', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));
  const head = sh(['rev-parse', 'HEAD'], repo);
  sh(['checkout', '-q', '--detach', head], repo);
  fs.writeFileSync(path.join(repo, 'detached-work.txt'), 'work\n');

  const snap = safety.snapshotRepo(repo, { id: 'test-5' });
  assert(snap.ok, 'snapshot failed');
  assert(snap.detached, 'detached state not recorded');
  assertEqual(sh(['show', `${snap.sha}:detached-work.txt`], repo), 'work', 'work not captured');
  assert(g.isDetached(repo), 'snapshot should not have re-attached HEAD');
});

test('ignores .gitignore\'d files by default, captures them with --all-files', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n');
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'out.js'), 'generated\n');

  const plain = safety.snapshotRepo(repo, { id: 'test-6a' });
  assert(!sh(['ls-tree', '-r', '--name-only', plain.sha], repo).includes('build/out.js'),
    'ignored file should not be captured by default');

  const everything = safety.snapshotRepo(repo, { id: 'test-6b', includeIgnored: true });
  assert(sh(['ls-tree', '-r', '--name-only', everything.sha], repo).includes('build/out.js'),
    '--all-files should capture ignored files');
});

/* ------------------------------------------------------------------ */

console.log('\ngit — worktree state');

test('distinguishes unstaged from staged changes', tmp => {
  // Regression: porcelain columns are position-significant, so trimming the
  // output turned " M file" (unstaged) into "M file" (staged).
  const repo = makeRepo(path.join(tmp, 'repo'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'edited\n');

  const state = g.worktreeState(repo);
  assertEqual(state.modified, 1, 'unstaged edit should count as modified');
  assertEqual(state.staged, 0, 'unstaged edit must not count as staged');
});

test('counts staged, modified and untracked separately', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'a\n');
  sh(['add', 'staged.txt'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'edited\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'c\n');

  const state = g.worktreeState(repo);
  assertEqual(state.staged, 1, 'staged count');
  assertEqual(state.modified, 1, 'modified count');
  assertEqual(state.untracked, 1, 'untracked count');
  assertEqual(state.clean, false, 'should not be clean');
});

test('reports a clean tree as clean', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));
  const state = g.worktreeState(repo);
  assertEqual(state.clean, true, 'fresh repo should be clean');
  assertEqual(state.total, 0, 'no changes expected');
});

/* ------------------------------------------------------------------ */

console.log('\nsafety — restore');

test('branch mode creates a branch and changes nothing else', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));
  fs.writeFileSync(path.join(repo, 'work.txt'), 'v1\n');

  const ws = fakeWorkspace(repo, []);
  const record = safety.snapshotAll(ws, { label: 'first' });
  assert(record.allOk, 'snapshot failed');

  fs.writeFileSync(path.join(repo, 'work.txt'), 'v2-current\n');

  const snapshot = safety.findSnapshot(ws, record.id);
  const results = safety.restoreSnapshot(ws, snapshot, { mode: 'branch' });
  assert(results.every(r => r.ok), `restore failed: ${JSON.stringify(results)}`);

  assertEqual(fs.readFileSync(path.join(repo, 'work.txt'), 'utf8'), 'v2-current\n',
    'branch mode must not touch the working tree');
  assert(g.refExists(repo, `refs/heads/poly/snap/${record.id}`), 'branch was not created');
  assertEqual(sh(['show', `poly/snap/${record.id}:work.txt`], repo), 'v1', 'branch has wrong content');
});

test('apply mode restores content and is itself reversible', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));
  fs.writeFileSync(path.join(repo, 'work.txt'), 'original\n');

  const ws = fakeWorkspace(repo, []);
  const first = safety.snapshotAll(ws, { label: 'good state' });

  fs.writeFileSync(path.join(repo, 'work.txt'), 'broken\n');
  fs.writeFileSync(path.join(repo, 'new-file.txt'), 'made later\n');

  const before = safety.snapshotAll(ws, { label: 'before restore' });
  safety.restoreSnapshot(ws, safety.findSnapshot(ws, first.id), { mode: 'apply' });

  assertEqual(fs.readFileSync(path.join(repo, 'work.txt'), 'utf8'), 'original\n', 'content not restored');
  assert(fs.existsSync(path.join(repo, 'new-file.txt')), 'apply must never delete files created since');

  // And the state we replaced is still recoverable.
  safety.restoreSnapshot(ws, safety.findSnapshot(ws, before.id), { mode: 'apply' });
  assertEqual(fs.readFileSync(path.join(repo, 'work.txt'), 'utf8'), 'broken\n', 'apply was not reversible');
});

test('restores bytes exactly in a repo that rewrites line endings', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));
  // The Git for Windows installer default. Set on the repo so this exercises
  // the same conversion on every platform, not only on a Windows runner.
  sh(['config', 'core.autocrlf', 'true'], repo);

  const lf = '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(path.join(repo, 'entrypoint.sh'), lf);

  const ws = fakeWorkspace(repo, []);
  const snap = safety.snapshotAll(ws, { label: 'lf line endings' });

  fs.writeFileSync(path.join(repo, 'entrypoint.sh'), 'clobbered\n');
  safety.restoreSnapshot(ws, safety.findSnapshot(ws, snap.id), { mode: 'apply' });

  assertEqual(fs.readFileSync(path.join(repo, 'entrypoint.sh'), 'utf8'), lf,
    'restore rewrote line endings instead of giving the bytes back');
});

test('snapshots stay discoverable after .poly is deleted', tmp => {
  const repo = makeRepo(path.join(tmp, 'repo'));
  fs.writeFileSync(path.join(repo, 'work.txt'), 'data\n');

  const ws = fakeWorkspace(repo, []);
  const record = safety.snapshotAll(ws, { label: 'journalled' });

  fs.rmSync(path.join(repo, '.poly'), { recursive: true, force: true });

  const found = safety.listSnapshots(ws);
  assert(found.length >= 1, 'snapshots must be readable from refs alone');
  assert(found.some(s => s.id === record.id), 'the snapshot disappeared with the journal');
});

/* ------------------------------------------------------------------ */

console.log('\nsafety — destructive commands are refused');

const DESTRUCTIVE = [
  ['reset', '--hard', 'HEAD~1'],
  ['checkout', '-f', 'main'],
  ['checkout', '--', '.'],
  ['clean', '-fd'],
  ['push', '--force', 'origin', 'main'],
  ['push', '--force-with-lease', 'origin', 'main'],
  ['branch', '-D', 'feature'],
  ['stash', 'drop'],
  ['stash', 'clear'],
  ['gc', '--prune=now'],
  ['reflog', 'expire', '--expire=now'],
  ['update-ref', '-d', 'refs/heads/main'],
  ['filter-branch', '--all'],
  ['rebase', 'main'],
  ['commit', '--amend', '-m', 'x'],
  ['restore', '.'],
  ['submodule', 'deinit', '--force', 'libs/x'],
  ['worktree', 'remove', 'wt'],
];

for (const args of DESTRUCTIVE) {
  test(`refuses: git ${args.join(' ')}`, () => {
    assertThrows(() => g.assertSafe(args), g.DestructiveCommandError,
      `git ${args.join(' ')} was allowed through`);
  });
}

const SAFE = [
  ['status', '--porcelain'],
  ['fetch', 'origin'],
  ['log', '-1'],
  ['branch', 'new-branch', 'HEAD'],
  ['checkout', 'main'],
  ['merge', '--ff-only', 'origin/main'],
  ['add', '-A'],
  ['commit', '-m', 'work'],
  ['restore', '--staged', 'file.txt'],
  ['stash', 'push'],
  ['update-ref', 'refs/poly/safety/x', 'HEAD'],
];

for (const args of SAFE) {
  test(`allows: git ${args.join(' ')}`, () => {
    g.assertSafe(args);
  });
}

/* ------------------------------------------------------------------ */

console.log('\npolicy — Gate 1 pointer integrity');

function makeSuperWithMember(tmp) {
  const member = makeRepo(path.join(tmp, 'member'), { initialFile: 'lib.js', content: 'v1\n' });
  sh(['config', 'receive.denyCurrentBranch', 'ignore'], member);

  const superRepo = makeRepo(path.join(tmp, 'super'));
  const memberUrl = member.replace(/\\/g, '/');
  sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', memberUrl, 'libs/member'], superRepo);
  sh(['commit', '-q', '-m', 'add submodule'], superRepo);

  const sub = path.join(superRepo, 'libs', 'member');
  manifest.write(superRepo, {
    ...manifest.DEFAULT_MANIFEST,
    superproject: { name: 'super', protectedBranches: ['main'] },
    members: [{ name: 'member', path: 'libs/member', url: memberUrl, protectedBranch: 'main', remote: 'origin', dependsOn: [] }],
  });

  return { member, superRepo, sub };
}

test('passes when the pointer is merged into the protected branch', tmp => {
  const { superRepo } = makeSuperWithMember(tmp);
  const ws = manifest.loadWorkspace(superRepo);
  const result = policy.gate1(ws, { treeish: 'INDEX' });

  const row = result.rows.find(r => r.name === 'member');
  assertEqual(row.status, 'ok', `expected ok, notes: ${row.notes.join(', ')}`);
  assertEqual(result.findings.filter(f => f.severity === 'error').length, 0, 'unexpected errors');
});

test('catches a pointer that is not merged into the protected branch', tmp => {
  const { superRepo, sub } = makeSuperWithMember(tmp);

  // A commit that exists only in the submodule checkout — exactly what happens
  // when the root is bumped before the member PR merges.
  fs.writeFileSync(path.join(sub, 'lib.js'), 'v2-unmerged\n');
  sh(['add', '-A'], sub);
  sh(['commit', '-q', '-m', 'unmerged work'], sub);
  sh(['add', 'libs/member'], superRepo);

  const ws = manifest.loadWorkspace(superRepo);
  const result = policy.gate1(ws, { treeish: 'INDEX' });

  const row = result.rows.find(r => r.name === 'member');
  assertEqual(row.status, 'unmerged', `expected unmerged, got ${row.status}`);

  const err = result.findings.find(f => f.severity === 'error' && f.invariant === 'I1');
  assert(err, 'expected an I1 error finding');
  assert(err.title.includes('not merged'), `unexpected finding: ${err.title}`);
});

test('passes once that same commit actually lands on the protected branch', tmp => {
  const { superRepo, sub } = makeSuperWithMember(tmp);

  fs.writeFileSync(path.join(sub, 'lib.js'), 'v2\n');
  sh(['add', '-A'], sub);
  sh(['commit', '-q', '-m', 'real work'], sub);
  sh(['push', '-q', 'origin', 'HEAD:main'], sub);   // the member PR merges
  sh(['fetch', '-q', 'origin'], sub);
  sh(['add', 'libs/member'], superRepo);

  const ws = manifest.loadWorkspace(superRepo);
  const result = policy.gate1(ws, { treeish: 'INDEX' });

  const row = result.rows.find(r => r.name === 'member');
  assertEqual(row.status, 'ok', `expected ok, notes: ${row.notes.join(', ')}`);
});

test('catches a pointer that references a commit which does not exist', tmp => {
  const { superRepo } = makeSuperWithMember(tmp);

  // Fabricate a gitlink to a commit no repo has ever seen — the squash-merge
  // failure mode, where the recorded PR head SHA is not what landed.
  const ghost = 'a'.repeat(40);
  sh(['update-index', '--add', '--cacheinfo', `160000,${ghost},libs/member`], superRepo);

  const ws = manifest.loadWorkspace(superRepo);
  const result = policy.gate1(ws, { treeish: 'INDEX' });

  const row = result.rows.find(r => r.name === 'member');
  assertEqual(row.status, 'broken', `expected broken, got ${row.status}`);
  assert(result.findings.some(f => f.severity === 'error' && f.title.includes('does not exist')),
    'expected a missing-commit error');
});

test('catches a pointer that moves backwards', tmp => {
  const { superRepo, sub } = makeSuperWithMember(tmp);

  const original = sh(['rev-parse', 'HEAD'], sub);
  fs.writeFileSync(path.join(sub, 'lib.js'), 'v2\n');
  sh(['add', '-A'], sub);
  sh(['commit', '-q', '-m', 'forward'], sub);
  sh(['push', '-q', 'origin', 'HEAD:main'], sub);
  sh(['fetch', '-q', 'origin'], sub);
  sh(['add', 'libs/member'], superRepo);
  sh(['commit', '-q', '-m', 'bump forward'], superRepo);

  // Now regress the pointer back to the older commit.
  sh(['update-index', '--cacheinfo', `160000,${original},libs/member`], superRepo);

  const ws = manifest.loadWorkspace(superRepo);
  const result = policy.gate1(ws, { treeish: 'INDEX' });

  assert(result.findings.some(f => f.title.includes('moves backwards')),
    `expected a regression finding, got: ${result.findings.map(f => f.title).join('; ')}`);
});

test('detects a gitlink with no .gitmodules entry (I6)', tmp => {
  const { superRepo } = makeSuperWithMember(tmp);
  fs.writeFileSync(path.join(superRepo, '.gitmodules'), '');

  const ws = manifest.loadWorkspace(superRepo);
  const findings = policy.checkManifestCoherence(ws);
  assert(findings.some(f => f.invariant === 'I6'), 'expected an I6 coherence finding');
});

/* ------------------------------------------------------------------ */

console.log('\ncli');

test('parses flags, negations and passthrough', () => {
  const { parseArgs } = require('../src/cli');

  const a = parseArgs(['save', 'my', 'label']);
  assertEqual(a.positional.join(' '), 'save my label');

  const b = parseArgs(['sync', '--no-fetch', '--pull']);
  assertEqual(b.flags.fetch, false, '--no-fetch should set fetch=false');
  assertEqual(b.flags.pull, true);

  // parseArgs does not consume the command name; main() shifts it.
  const c2 = parseArgs(['restore', 'abc', '--branch', 'my-branch', '--apply']);
  assertEqual(c2.flags.branch, 'my-branch');
  assertEqual(c2.flags.apply, true);
  assertEqual(c2.positional[1], 'abc');

  const d = parseArgs(['run', '--', 'git', '--version']);
  assertEqual(d.positional.join(' '), 'run git --version', 'passthrough after -- failed');
});

test('every command exposes help metadata', () => {
  const { COMMANDS } = require('../src/cli');
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    assert(typeof cmd.run === 'function', `${name} has no run()`);
    assert(cmd.help && cmd.help.usage && cmd.help.summary, `${name} has incomplete help`);
  }
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  for (const f of failures) {
    console.log(`\x1b[31m${f.name}\x1b[39m`);
    console.log(f.err.stack.split('\n').slice(0, 6).join('\n'));
    console.log();
  }
}
process.exit(failed ? 1 : 0);
