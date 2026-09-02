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

// Async tests are queued and run after every sync test (see the runner at the
// end of the file). Same fixture-dir lifecycle, just awaited.
const asyncTests = [];
function atest(name, fn) {
  asyncTests.push({ name, fn });
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

  // value flags: --changeset takes the next token; --member repeats into an array
  const e = parseArgs(['land', '--changeset', '20260101-000000-aaaa', '--dry-run']);
  assertEqual(e.flags.changeset, '20260101-000000-aaaa', '--changeset did not consume its value');
  assertEqual(e.flags['dry-run'], true);

  const f = parseArgs(['changeset', 'new', 'title', '--member', 'a', '--member', 'b']);
  assertEqual(JSON.stringify(f.flags.member), '["a","b"]', 'repeated --member should accumulate');
});

test('run passes the wrapped program its own flags, with or without --', () => {
  const { parseArgs } = require('../src/cli');

  // The bug this prevents: -b claimed by poly, so every repo ran
  // `git checkout 1.x.x` — a switch to a branch that does not exist yet.
  const bare = parseArgs(['run', 'git', 'checkout', '-b', '1.x.x']);
  assertEqual(bare.positional.join(' '), 'run git checkout -b 1.x.x', 'short flag was swallowed');
  assertEqual(bare.flags.b, undefined, 'poly claimed a flag belonging to git');

  // An explicit -- still works, and must not show up in the command.
  const dashed = parseArgs(['run', '--', 'git', 'checkout', '-b', '1.x.x']);
  assertEqual(dashed.positional.join(' '), bare.positional.join(' '), '-- changed the result');

  // poly's own flags come before the program name.
  const mine = parseArgs(['run', '--keep-going', 'npm', 'test', '--bail']);
  assertEqual(mine.flags['keep-going'], true, 'poly flag before the program was not read');
  assertEqual(mine.positional.join(' '), 'run npm test --bail', 'program flags were not passed through');

  // Aliases resolve to the same rule.
  for (const alias of ['foreach', 'each']) {
    const a = parseArgs([alias, 'git', 'log', '--oneline', '-3']);
    assertEqual(a.positional.join(' '), `${alias} git log --oneline -3`, `${alias} did not pass through`);
  }

  // Commands that are not wrappers keep parsing flags as before.
  const s = parseArgs(['restore', 'abc', '--branch', 'my-branch', '--apply']);
  assertEqual(s.flags.branch, 'my-branch', 'non-wrapper command lost a flag');
  assertEqual(s.flags.apply, true, 'non-wrapper command lost a flag');
});

test('every command exposes help metadata', () => {
  const { COMMANDS } = require('../src/cli');
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    assert(typeof cmd.run === 'function', `${name} has no run()`);
    assert(cmd.help && cmd.help.usage && cmd.help.summary, `${name} has incomplete help`);
  }
});

/* ------------------------------------------------------------------ */

console.log('\npins — durable pins');

function landOnMain(sub, file, content, msg) {
  fs.writeFileSync(path.join(sub, file), content);
  sh(['add', '-A'], sub);
  sh(['commit', '-q', '-m', msg], sub);
  sh(['push', '-q', 'origin', 'HEAD:main'], sub);
  sh(['fetch', '-q', 'origin'], sub);
}

test('poly pin writes a ref for the pointer and satisfies requirePins', tmp => {
  const pins = require('../src/pins');
  const { superRepo, sub } = makeSuperWithMember(tmp);
  landOnMain(sub, 'lib.js', 'v2\n', 'v2');
  sh(['add', 'libs/member'], superRepo);

  const ws = manifest.loadWorkspace(superRepo);
  const sha = g.gitlinksInIndex(superRepo).find(l => l.path === 'libs/member').sha;

  ws.manifest.policy.requirePins = true;
  assert(policy.gate1(ws, { treeish: 'INDEX' }).findings.some(f => f.invariant === 'I2'),
    'expected an I2 finding before pinning');

  const res = pins.pin(path.join(superRepo, 'libs', 'member'), { name: 'member', sha });
  assert(res.ok, `pin failed: ${res.error}`);
  assert(g.refExists(path.join(superRepo, 'libs', 'member'), res.ref), 'pin ref was not written');

  assert(!policy.gate1(ws, { treeish: 'INDEX' }).findings.some(f => f.invariant === 'I2'),
    'I2 finding should be gone once the pointer is pinned');
});

test('a pinned commit survives branch deletion and aggressive gc', tmp => {
  const pins = require('../src/pins');
  const { superRepo, sub } = makeSuperWithMember(tmp);
  sh(['checkout', '-q', '-b', 'doomed'], sub);
  fs.writeFileSync(path.join(sub, 'lib.js'), 'pinned work\n');
  sh(['add', '-A'], sub);
  sh(['commit', '-q', '-m', 'work'], sub);
  const sha = sh(['rev-parse', 'HEAD'], sub);

  pins.pin(sub, { name: 'member', sha });

  sh(['checkout', '-q', 'main'], sub);
  sh(['branch', '-q', '-D', 'doomed'], sub);
  sh(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], sub);
  sh(['gc', '--prune=now', '--aggressive', '-q'], sub);

  assert(g.commitExists(sub, sha), 'pinned commit was garbage-collected');
});

/* ------------------------------------------------------------------ */

console.log('\ngraph — dependsOn ordering');

test('topoSort respects dependsOn and returns every member', () => {
  const { topoSort } = require('../src/graph');
  const members = [
    { name: 'c', dependsOn: ['b'] },
    { name: 'a', dependsOn: [] },
    { name: 'b', dependsOn: ['a'] },
    { name: 'd', dependsOn: [] },
  ];
  const { order } = topoSort(members);
  const at = n => order.findIndex(m => m.name === n);
  assertEqual(order.length, 4, 'every member should appear once');
  assert(at('a') < at('b') && at('b') < at('c'), 'dependency order was violated');
});

test('topoSort reports unknown deps and throws on a cycle', () => {
  const { topoSort } = require('../src/graph');
  const { unknownDeps } = topoSort([{ name: 'a', dependsOn: ['ghost'] }]);
  assertEqual(unknownDeps[0].missing[0], 'ghost');

  const err = assertThrows(
    () => topoSort([{ name: 'x', dependsOn: ['y'] }, { name: 'y', dependsOn: ['x'] }])
  );
  assert(/cycle/.test(err.message), `expected a cycle error, got: ${err.message}`);
  assert(err.userFacing, 'a cycle error should be userFacing');
});

/* ------------------------------------------------------------------ */

console.log('\ngithub — I3 review integrity');

test('parseGithubRepo handles https and ssh, rejects non-github', () => {
  const { parseGithubRepo } = require('../src/github');
  assertEqual(JSON.stringify(parseGithubRepo('https://github.com/was-pos/pos-ms-auth-service.git')),
    '{"owner":"was-pos","repo":"pos-ms-auth-service"}');
  assertEqual(JSON.stringify(parseGithubRepo('git@github.com:o/r.git')), '{"owner":"o","repo":"r"}');
  assertEqual(parseGithubRepo('https://gitlab.com/o/r.git'), null);
  assertEqual(parseGithubRepo(null), null);
});

atest('augmentWithReviews maps merged+approved and not-merged via an injected transport', async tmp => {
  const { superRepo } = makeSuperWithMember(tmp);
  const ws = manifest.loadWorkspace(superRepo);
  ws.members[0].url = 'https://github.com/o/r.git';

  // merged + approved -> no I3 finding
  const okResult = policy.gate1(ws, { treeish: 'INDEX' });
  const transport = p => {
    if (/\/commits\/.+\/pulls$/.test(p)) {
      return { ok: true, status: 200, body: [{ number: 7, merged_at: '2026-01-01T00:00:00Z', base: { ref: 'main' } }] };
    }
    if (/\/pulls\/7\/reviews$/.test(p)) {
      return { ok: true, status: 200, body: [{ user: { login: 'r' }, state: 'APPROVED' }] };
    }
    return { ok: false, status: 404, body: null };
  };
  await policy.augmentWithReviews(okResult, ws, { auth: { mode: 'token', token: 'x' }, transport });
  assert(!okResult.findings.some(f => f.invariant === 'I3'), 'approved+merged should not raise I3');
  assertEqual(okResult.rows[0].review.reviewDecision, 'approved');

  // no merged PR -> an I3 finding
  const badResult = policy.gate1(ws, { treeish: 'INDEX' });
  await policy.augmentWithReviews(badResult, ws, {
    auth: { mode: 'token', token: 'x' },
    transport: () => ({ ok: true, status: 200, body: [] }),
  });
  assert(badResult.findings.some(f => f.invariant === 'I3'), 'a commit with no merged PR should raise I3');
});

atest('augmentWithReviews leaves I3 "not checked" when there is no auth', async tmp => {
  const { superRepo } = makeSuperWithMember(tmp);
  const ws = manifest.loadWorkspace(superRepo);
  ws.members[0].url = 'https://github.com/o/r.git';
  const result = policy.gate1(ws, { treeish: 'INDEX' });
  await policy.augmentWithReviews(result, ws, { auth: { mode: 'none', reason: 'no GitHub auth' } });
  assert(!result.findings.some(f => f.invariant === 'I3'), 'no auth must not invent findings');
  assert(result.notChecked.some(n => n.startsWith('I3 ')), 'I3 should be reported as not checked');
});

/* ------------------------------------------------------------------ */

console.log('\nchangeset — cross-repo tracking');

test('changeset records branch + pointer, refresh sees the merge', tmp => {
  const cs = require('../src/changeset');
  const { superRepo, sub } = makeSuperWithMember(tmp);
  sh(['checkout', '-q', '-b', 'feature/x'], sub);
  fs.writeFileSync(path.join(sub, 'lib.js'), 'v2\n');
  sh(['add', '-A'], sub);
  sh(['commit', '-q', '-m', 'v2'], sub);

  let ws = manifest.loadWorkspace(superRepo);
  const rec = cs.create(ws, { title: 'my change', memberNames: ['member'] });
  assertEqual(rec.members[0].branch, 'feature/x');
  assertEqual(rec.members[0].merged, false);

  sh(['push', '-q', 'origin', 'feature/x:main'], sub);
  sh(['fetch', '-q', 'origin'], sub);

  ws = manifest.loadWorkspace(superRepo);
  const { cs: updated } = cs.refresh(ws, cs.read(superRepo, rec.id));
  assertEqual(updated.members[0].merged, true, 'refresh should see the branch merged into main');
});

/* ------------------------------------------------------------------ */

console.log('\npr — open pull requests');

atest('createPullRequest posts the right payload and maps the response', async () => {
  const github = require('../src/github');
  let seen = null;
  const transport = (p, cx) => {
    seen = { p, method: cx.method, body: cx.body };
    return { ok: true, status: 201, body: { number: 42, html_url: 'https://github.com/o/r/pull/42' } };
  };
  const res = await github.createPullRequest(
    { owner: 'o', repo: 'r', head: '1.x.x', base: 'main', title: 'T', body: 'B', draft: true },
    { mode: 'token', token: 'x' }, transport
  );
  assertEqual(seen.p, '/repos/o/r/pulls', 'wrong path');
  assertEqual(seen.method, 'POST', 'wrong method');
  assertEqual(seen.body.head, '1.x.x');
  assertEqual(seen.body.base, 'main');
  assertEqual(seen.body.draft, true);
  assertEqual(res.status, 'created');
  assertEqual(res.number, 42);
  assertEqual(res.url, 'https://github.com/o/r/pull/42');
});

atest('createPullRequest resolves an "already exists" 422 to the open PR', async () => {
  const github = require('../src/github');
  const transport = (p, cx) => {
    if (cx.method === 'POST') {
      return { ok: false, status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for o:x.' }] } };
    }
    return { ok: true, status: 200, body: [{ number: 7, html_url: 'https://github.com/o/r/pull/7' }] };
  };
  const res = await github.createPullRequest(
    { owner: 'o', repo: 'r', head: 'x', base: 'main' }, { mode: 'token', token: 'x' }, transport
  );
  assertEqual(res.status, 'exists', 'a duplicate PR should resolve to the existing one');
  assertEqual(res.number, 7);
});

atest('planPullRequests flags detached, on-protected, unpushed and non-github', async tmp => {
  const pr = require('../src/pr');
  const { superRepo, sub } = makeSuperWithMember(tmp);

  // superproject sits on main (its protected branch) and has no github remote
  let ws = manifest.loadWorkspace(superRepo);
  let superT = pr.planPullRequests(ws, {}).targets.find(t => t.role === 'superproject');
  assert(/on main/.test(superT.blocker || ''), `super blocker: ${superT.blocker}`);

  // member on a feature branch, not yet pushed
  sh(['checkout', '-q', '-b', 'feat/x'], sub);
  fs.writeFileSync(path.join(sub, 'lib.js'), 'v2\n');
  sh(['add', '-A'], sub);
  sh(['commit', '-q', '-m', 'v2'], sub);
  ws = manifest.loadWorkspace(superRepo);
  let memT = pr.planPullRequests(ws, {}).targets.find(t => t.role === 'member');
  assert(/not pushed/.test(memT.blocker || ''), `expected unpushed, got: ${memT.blocker}`);

  // pushed, but origin is a local path — not github.com
  sh(['push', '-q', '-u', 'origin', 'feat/x'], sub);
  sh(['fetch', '-q', 'origin'], sub);
  ws = manifest.loadWorkspace(superRepo);
  memT = pr.planPullRequests(ws, {}).targets.find(t => t.role === 'member');
  assert(/github\.com/.test(memT.blocker || ''), `expected non-github, got: ${memT.blocker}`);

  // detached HEAD
  sh(['checkout', '-q', '--detach', 'HEAD'], sub);
  ws = manifest.loadWorkspace(superRepo);
  memT = pr.planPullRequests(ws, {}).targets.find(t => t.role === 'member');
  assert(/detached/.test(memT.blocker || ''), `expected detached, got: ${memT.blocker}`);
});

atest('openPullRequests creates one PR per member and skips the superproject with --members-only', async tmp => {
  const pr = require('../src/pr');
  const { superRepo, subA, subB } = makeSuperTwo(tmp);

  for (const s of [subA, subB]) {
    sh(['checkout', '-q', '-b', 'feat/change'], s);
    fs.writeFileSync(path.join(s, path.basename(s) === 'a' ? 'a.txt' : 'b.txt'), 'work\n');
    sh(['add', '-A'], s);
    sh(['commit', '-q', '-m', 'work'], s);
    sh(['push', '-q', '-u', 'origin', 'feat/change'], s);
    sh(['fetch', '-q', 'origin'], s);
  }

  const ws = manifest.loadWorkspace(superRepo);
  ws.members.forEach(mem => { mem.url = `https://github.com/o/${mem.name}.git`; });

  const { targets } = pr.planPullRequests(ws, { membersOnly: true });
  assertEqual(targets.length, 2, 'only the two members should be in scope');
  assert(targets.every(t => !t.blocker), `unexpected blocker: ${targets.map(t => t.blocker).join('; ')}`);

  const calls = [];
  const transport = (p, cx) => {
    calls.push({ p, method: cx.method });
    if (cx.method === 'POST') return { ok: true, status: 201, body: { number: calls.length, html_url: `u${calls.length}` } };
    return { ok: true, status: 200, body: [] }; // no existing PR
  };
  const results = await pr.openPullRequests(ws, targets, { auth: { mode: 'token', token: 'x' }, transport });

  assertEqual(results.filter(r => r.status === 'created').length, 2, 'both member PRs should be created');
  assert(results.every(r => r.base === 'main'), 'PRs should target main');
  assert(calls.some(c => c.method === 'POST' && /\/o\/a\/pulls$/.test(c.p)), 'no POST for member a');
});

atest('openPullRequests reports an already-open PR instead of creating one', async tmp => {
  const pr = require('../src/pr');
  const { superRepo, subA } = makeSuperTwo(tmp);
  sh(['checkout', '-q', '-b', 'feat/dup'], subA);
  fs.writeFileSync(path.join(subA, 'a.txt'), 'x\n');
  sh(['add', '-A'], subA);
  sh(['commit', '-q', '-m', 'x'], subA);
  sh(['push', '-q', '-u', 'origin', 'feat/dup'], subA);
  sh(['fetch', '-q', 'origin'], subA);

  const ws = manifest.loadWorkspace(superRepo);
  ws.members.forEach(mem => { mem.url = `https://github.com/o/${mem.name}.git`; });
  const { targets } = pr.planPullRequests(ws, { memberNames: ['a'], membersOnly: true });

  let posted = false;
  const transport = (p, cx) => {
    if (cx.method === 'POST') { posted = true; return { ok: false, status: 500, body: null }; }
    return { ok: true, status: 200, body: [{ number: 9, html_url: 'https://github.com/o/a/pull/9' }] };
  };
  const results = await pr.openPullRequests(ws, targets, { auth: { mode: 'token', token: 'x' }, transport });

  assertEqual(results.length, 1);
  assertEqual(results[0].status, 'exists');
  assertEqual(results[0].number, 9);
  assert(!posted, 'must not POST when a PR is already open');
});

atest('pr --changeset scopes the PRs to the change set members', async tmp => {
  const cs = require('../src/changeset');
  const pr = require('../src/pr');
  const { superRepo, subA, subB } = makeSuperTwo(tmp);

  for (const s of [subA, subB]) {
    sh(['checkout', '-q', '-b', 'feat/x'], s);
    fs.writeFileSync(path.join(s, path.basename(s) === 'a' ? 'a.txt' : 'b.txt'), 'w\n');
    sh(['add', '-A'], s);
    sh(['commit', '-q', '-m', 'w'], s);
    sh(['push', '-q', '-u', 'origin', 'feat/x'], s);
    sh(['fetch', '-q', 'origin'], s);
  }

  const rec = cs.create(manifest.loadWorkspace(superRepo), { title: 'just a', memberNames: ['a'] });

  const ws = manifest.loadWorkspace(superRepo);
  ws.members.forEach(mem => { mem.url = `https://github.com/o/${mem.name}.git`; });
  const { targets, changeset } = pr.planPullRequests(ws, { changesetId: rec.id, membersOnly: true });

  assertEqual(changeset.id, rec.id, 'changeset should be resolved');
  assertEqual(targets.length, 1, 'only the change set member should be in scope');
  assertEqual(targets[0].name, 'a');
});

/* ------------------------------------------------------------------ */

console.log('\nland — ordered bump + Gate 1 + commit');

function makeSuperTwo(tmp) {
  const a = makeRepo(path.join(tmp, 'a'), { initialFile: 'a.txt', content: 'a1\n' });
  const b = makeRepo(path.join(tmp, 'b'), { initialFile: 'b.txt', content: 'b1\n' });
  for (const r of [a, b]) sh(['config', 'receive.denyCurrentBranch', 'ignore'], r);

  const superRepo = makeRepo(path.join(tmp, 'super'));
  const au = a.replace(/\\/g, '/');
  const bu = b.replace(/\\/g, '/');
  sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', au, 'libs/a'], superRepo);
  sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', bu, 'libs/b'], superRepo);
  sh(['commit', '-q', '-m', 'add submodules'], superRepo);

  manifest.write(superRepo, {
    ...manifest.DEFAULT_MANIFEST,
    superproject: { name: 'super', protectedBranches: ['main'] },
    members: [
      { name: 'a', path: 'libs/a', url: au, protectedBranch: 'main', remote: 'origin', dependsOn: [] },
      { name: 'b', path: 'libs/b', url: bu, protectedBranch: 'main', remote: 'origin', dependsOn: ['a'] },
    ],
  });
  return { a, b, superRepo, subA: path.join(superRepo, 'libs', 'a'), subB: path.join(superRepo, 'libs', 'b') };
}

atest('land bumps both pointers in one commit', async tmp => {
  const land = require('../src/commands/land');
  const { a, superRepo, subA, subB } = makeSuperTwo(tmp);
  landOnMain(subA, 'a.txt', 'a2\n', 'a2');
  landOnMain(subB, 'b.txt', 'b2\n', 'b2');

  const before = sh(['rev-parse', 'HEAD'], superRepo);
  const code = await land.run({ flags: {}, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, 'land should succeed');

  assertEqual(sh(['rev-list', '--count', `${before}..HEAD`], superRepo), '1', 'exactly one commit');
  assert(sh(['log', '-1', '--format=%s'], superRepo).includes('poly land'), 'commit subject');

  const links = g.gitlinksInTree(superRepo, 'HEAD');
  assertEqual(links.find(l => l.path === 'libs/a').sha, sh(['rev-parse', 'main'], a),
    'libs/a was not bumped to its protected-branch tip');
});

atest('land --dry-run changes nothing', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, subA } = makeSuperTwo(tmp);
  landOnMain(subA, 'a.txt', 'a2\n', 'a2');

  const superBefore = sh(['rev-parse', 'HEAD'], superRepo);
  const subBefore = sh(['rev-parse', 'HEAD'], subA);
  const code = await land.run({ flags: { 'dry-run': true }, positional: [] }, { cwd: superRepo, json: true });

  assertEqual(code, 0);
  assertEqual(sh(['rev-parse', 'HEAD'], superRepo), superBefore, 'superproject moved');
  assertEqual(sh(['rev-parse', 'HEAD'], subA), subBefore, 'submodule checkout moved');
  assert(!fs.existsSync(path.join(superRepo, '.poly', 'snapshots.json')), 'dry-run must not snapshot');
});

atest('land stops before committing when a pointer is not a forward move', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, subA } = makeSuperTwo(tmp);
  // a commit that is ahead of origin/main — bumping to main would move backwards
  fs.writeFileSync(path.join(subA, 'a.txt'), 'a2-local\n');
  sh(['add', '-A'], subA);
  sh(['commit', '-q', '-m', 'local only'], subA);
  sh(['add', 'libs/a'], superRepo);

  const before = sh(['rev-parse', 'HEAD'], superRepo);
  const code = await land.run({ flags: {}, positional: [] }, { cwd: superRepo, json: true });

  assertEqual(code, 1, 'land should refuse');
  assertEqual(sh(['rev-parse', 'HEAD'], superRepo), before, 'no commit should have been made');
});

atest('land --self fast-forwards the superproject protected branch without switching', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, subA } = makeSuperTwo(tmp);
  landOnMain(subA, 'a.txt', 'a2\n', 'a2');

  sh(['checkout', '-q', '-b', 'feat/bump'], superRepo);
  sh(['add', 'libs/a'], superRepo);
  sh(['commit', '-q', '-m', 'bump libs/a'], superRepo);
  const featTip = sh(['rev-parse', 'HEAD'], superRepo);

  const code = await land.run({ flags: { self: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, 'land --self should succeed');
  assertEqual(sh(['rev-parse', 'main'], superRepo), featTip, 'main was not fast-forwarded to the feature tip');
  assertEqual(sh(['rev-parse', '--abbrev-ref', 'HEAD'], superRepo), 'feat/bump', 'must not switch branches by default');
});

atest('land --self --switch checks out the protected branch', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, subA } = makeSuperTwo(tmp);
  landOnMain(subA, 'a.txt', 'a2\n', 'a2');
  sh(['checkout', '-q', '-b', 'feat/bump'], superRepo);
  sh(['add', 'libs/a'], superRepo);
  sh(['commit', '-q', '-m', 'bump'], superRepo);

  const code = await land.run({ flags: { self: true, switch: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0);
  assertEqual(sh(['rev-parse', '--abbrev-ref', 'HEAD'], superRepo), 'main', '--switch should end on the protected branch');
});

atest('land --self refuses a non-fast-forward and moves nothing', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, subA } = makeSuperTwo(tmp);
  landOnMain(subA, 'a.txt', 'a2\n', 'a2');

  sh(['checkout', '-q', '-b', 'feat/x'], superRepo);
  sh(['add', 'libs/a'], superRepo);
  sh(['commit', '-q', '-m', 'bump on feature'], superRepo);
  sh(['checkout', '-q', 'main'], superRepo);
  fs.writeFileSync(path.join(superRepo, 'notes.md'), 'main-only\n');
  sh(['add', 'notes.md'], superRepo);
  sh(['commit', '-q', '-m', 'main moves on'], superRepo);
  sh(['checkout', '-q', 'feat/x'], superRepo);
  const mainBefore = sh(['rev-parse', 'main'], superRepo);

  const code = await land.run({ flags: { self: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 1, 'should refuse a non-fast-forward');
  assertEqual(sh(['rev-parse', 'main'], superRepo), mainBefore, 'main must not have moved');
});

atest('land --self --dry-run moves no refs and takes no snapshot', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, subA } = makeSuperTwo(tmp);
  landOnMain(subA, 'a.txt', 'a2\n', 'a2');
  sh(['checkout', '-q', '-b', 'feat/bump'], superRepo);
  sh(['add', 'libs/a'], superRepo);
  sh(['commit', '-q', '-m', 'bump'], superRepo);
  const mainBefore = sh(['rev-parse', 'main'], superRepo);

  const code = await land.run({ flags: { self: true, 'dry-run': true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0);
  assertEqual(sh(['rev-parse', 'main'], superRepo), mainBefore, 'dry-run moved main');
  assert(!fs.existsSync(path.join(superRepo, '.poly', 'snapshots.json')), 'dry-run must not snapshot');
});

// A superproject feature branch with one commit that lands cleanly onto main.
function superOnFeature(tmp, branch = 'feat/bump') {
  const { superRepo, subA, subB } = makeSuperTwo(tmp);
  landOnMain(subA, 'a.txt', 'a2\n', 'a2');
  sh(['checkout', '-q', '-b', branch], superRepo);
  sh(['add', 'libs/a'], superRepo);
  sh(['commit', '-q', '-m', 'bump libs/a'], superRepo);
  return { superRepo, subA, subB, tip: sh(['rev-parse', 'HEAD'], superRepo) };
}

atest('land --self records the undo ref and --undo walks main back non-destructively', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, tip } = superOnFeature(tmp);
  const mainBefore = sh(['rev-parse', 'main'], superRepo);

  let code = await land.run({ flags: { self: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, 'land --self should succeed');
  assertEqual(sh(['rev-parse', 'main'], superRepo), tip, 'main should have landed');
  assertEqual(sh(['rev-parse', 'refs/poly/land/main/from'], superRepo), mainBefore, 'undo anchor /from not recorded');
  assertEqual(sh(['rev-parse', 'refs/poly/land/main/onto'], superRepo), tip, 'undo anchor /onto not recorded');

  code = await land.run({ flags: { self: true, undo: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, 'undo should succeed');
  assertEqual(sh(['rev-parse', 'main'], superRepo), mainBefore, 'undo did not move main back');
  assert(g.commitExists(superRepo, tip), 'the un-landed commit must stay reachable');

  // A second undo is a no-op, not an error.
  code = await land.run({ flags: { self: true, undo: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, 'a redundant undo should be a no-op');
});

atest('land --self --undo refuses once main has moved on', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo } = superOnFeature(tmp);
  await land.run({ flags: { self: true, switch: true }, positional: [] }, { cwd: superRepo, json: true });

  // main advances again, past the recorded undo point
  fs.writeFileSync(path.join(superRepo, 'later.md'), 'more\n');
  sh(['add', 'later.md'], superRepo);
  sh(['commit', '-q', '-m', 'later work on main'], superRepo);
  const mainNow = sh(['rev-parse', 'main'], superRepo);

  const code = await land.run({ flags: { self: true, undo: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 1, 'undo should refuse after main moved on');
  assertEqual(sh(['rev-parse', 'main'], superRepo), mainNow, 'main must not have moved');
});

atest('land --self --undo refuses while the protected branch is checked out', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, tip } = superOnFeature(tmp);
  await land.run({ flags: { self: true, switch: true }, positional: [] }, { cwd: superRepo, json: true });
  // still on main after --switch
  const code = await land.run({ flags: { self: true, undo: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 2, 'undo must refuse while sitting on the protected branch');
  assertEqual(sh(['rev-parse', 'main'], superRepo), tip, 'main must be untouched');
});

atest('land --self refuses on a Gate 1 error, and --no-verify overrides it', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, subA } = makeSuperTwo(tmp);
  // a commit only in the submodule checkout — never lands on origin/main
  fs.writeFileSync(path.join(subA, 'a.txt'), 'a2-unmerged\n');
  sh(['add', '-A'], subA);
  sh(['commit', '-q', '-m', 'unmerged'], subA);
  sh(['checkout', '-q', '-b', 'feat/bump'], superRepo);
  sh(['add', 'libs/a'], superRepo);
  sh(['commit', '-q', '-m', 'bump to unmerged pointer'], superRepo);
  const mainBefore = sh(['rev-parse', 'main'], superRepo);

  let code = await land.run({ flags: { self: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 1, 'a Gate 1 error should block the land');
  assertEqual(sh(['rev-parse', 'main'], superRepo), mainBefore, 'main moved despite a Gate 1 error');

  code = await land.run({ flags: { self: true, 'no-verify': true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, '--no-verify should let it through');
  assertEqual(sh(['rev-parse', 'main'], superRepo), sh(['rev-parse', 'feat/bump'], superRepo), '--no-verify did not land');
});

atest('land --self refuses a dirty tracked tree, and --force overrides it', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo, tip } = superOnFeature(tmp);
  fs.writeFileSync(path.join(superRepo, '.gitmodules'),
    sh(['show', 'HEAD:.gitmodules'], superRepo) + '\n# touched\n');
  const mainBefore = sh(['rev-parse', 'main'], superRepo);

  let code = await land.run({ flags: { self: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 2, 'a dirty tracked file should block');
  assertEqual(sh(['rev-parse', 'main'], superRepo), mainBefore, 'main moved despite a dirty tree');

  code = await land.run({ flags: { self: true, force: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, '--force should override the dirty-tree check');
  assertEqual(sh(['rev-parse', 'main'], superRepo), tip, '--force did not land');
});

atest('land --self --push publishes the protected branch to its remote', async tmp => {
  const land = require('../src/commands/land');
  const bare = path.join(tmp, 'super-origin.git');
  sh(['init', '-q', '--bare', bare], tmp);
  const { superRepo, tip } = superOnFeature(tmp);
  sh(['remote', 'add', 'origin', bare.replace(/\\/g, '/')], superRepo);
  sh(['push', '-q', 'origin', 'main'], superRepo);

  const code = await land.run({ flags: { self: true, push: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, 'land --self --push should succeed');
  assertEqual(sh(['rev-parse', 'main'], bare), tip, 'the bare origin main was not fast-forwarded');
});

atest('land --self is refused on a detached HEAD and when already on the protected branch', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo } = makeSuperTwo(tmp);

  const onMain = await land.run({ flags: { self: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(onMain, 2, 'being on the protected branch should be refused');

  sh(['checkout', '-q', '--detach', 'HEAD'], superRepo);
  const detached = await land.run({ flags: { self: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(detached, 2, 'a detached HEAD should be refused');
});

atest('land --self reports nothing to land when the branch has no new commits', async tmp => {
  const land = require('../src/commands/land');
  const { superRepo } = makeSuperTwo(tmp);
  sh(['checkout', '-q', '-b', 'feat/empty'], superRepo); // same tip as main
  const mainBefore = sh(['rev-parse', 'main'], superRepo);

  const code = await land.run({ flags: { self: true }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, 'nothing to land is not an error');
  assertEqual(sh(['rev-parse', 'main'], superRepo), mainBefore, 'main should be untouched');
});

atest('land --self --changeset refuses an unmerged set, then lands and marks it', async tmp => {
  const land = require('../src/commands/land');
  const cs = require('../src/changeset');
  const { superRepo, subA } = makeSuperTwo(tmp);

  sh(['checkout', '-q', '-b', 'feat/a'], subA);
  fs.writeFileSync(path.join(subA, 'a.txt'), 'a2\n');
  sh(['add', '-A'], subA);
  sh(['commit', '-q', '-m', 'a2'], subA);

  const rec = cs.create(manifest.loadWorkspace(superRepo), { title: 'the change', memberNames: ['a'] });

  sh(['add', 'libs/a'], superRepo);
  sh(['checkout', '-q', '-b', 'feat/bump'], superRepo);
  sh(['commit', '-q', '-m', 'bump libs/a'], superRepo);
  const mainBefore = sh(['rev-parse', 'main'], superRepo);

  // member not merged yet — refuse (skip Gate 1 so the change-set check is what bites)
  let code = await land.run(
    { flags: { self: true, changeset: rec.id, 'no-verify': true }, positional: [] },
    { cwd: superRepo, json: true });
  assertEqual(code, 1, 'should refuse while the change-set member is unmerged');
  assertEqual(sh(['rev-parse', 'main'], superRepo), mainBefore, 'main must not have moved');

  // merge the member; now it lands and the set is marked
  sh(['push', '-q', 'origin', 'feat/a:main'], subA);
  sh(['fetch', '-q', 'origin'], subA);

  code = await land.run({ flags: { self: true, changeset: rec.id }, positional: [] }, { cwd: superRepo, json: true });
  assertEqual(code, 0, 'should land once the member merged');
  assertEqual(cs.read(superRepo, rec.id).status, 'landed', 'change set was not marked landed');
});

atest('status surfaces a superproject branch that is ready for land --self', async tmp => {
  const status = require('../src/commands/status');
  const { superRepo, subA } = makeSuperTwo(tmp);
  landOnMain(subA, 'a.txt', 'a2\n', 'a2');
  sh(['checkout', '-q', '-b', 'feat/bump'], superRepo);
  sh(['add', 'libs/a'], superRepo);
  sh(['commit', '-q', '-m', 'bump'], superRepo);

  const lines = [];
  const orig = console.log;
  console.log = s => lines.push(String(s));
  try {
    status.run({ flags: {}, positional: [] }, { cwd: superRepo, json: true });
  } finally {
    console.log = orig;
  }
  const out = JSON.parse(lines.join('\n'));
  assert(out.superproject.readyToLandSelf, 'status should report readyToLandSelf');
  assertEqual(out.superproject.readyToLandSelf.ahead, 1, 'wrong ahead count');
  assertEqual(out.superproject.readyToLandSelf.protectedBranch, 'main', 'wrong protected branch');
});

/* ------------------------------------------------------------------ */

(async () => {
  for (const { name, fn } of asyncTests) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-test-'));
    try {
      await fn(dir);
      passed++;
      console.log(`  \x1b[32m✓\x1b[39m ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, err });
      console.log(`  \x1b[31m✗\x1b[39m ${name}`);
      console.log(`      ${String(err && err.message).split('\n').join('\n      ')}`);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows file locks */ }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    for (const f of failures) {
      console.log(`\x1b[31m${f.name}\x1b[39m`);
      console.log((f.err.stack || String(f.err)).split('\n').slice(0, 6).join('\n'));
      console.log();
    }
  }
  process.exit(failed ? 1 : 0);
})();
