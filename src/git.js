'use strict';
/**
 * Git wrapper.
 *
 * The single most important property of this module: it refuses to run
 * commands that can destroy uncommitted or unpushed work. Every git call in
 * the tool goes through here, so the guarantee holds no matter which command
 * the user typed.
 *
 * The only escape hatch is `allowDestructive: true`, which exactly one call
 * site uses (restore --apply), and only after a snapshot has been written to a
 * durable ref.
 */

const { execFileSync, execFile } = require('child_process');

class GitError extends Error {
  constructor(message, { args, cwd, stderr, code }) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.cwd = cwd;
    this.stderr = stderr;
    this.code = code;
  }
}

class DestructiveCommandError extends Error {
  constructor(rule, args) {
    super(
      `Refused to run a destructive git command: git ${args.join(' ')}\n` +
      `  Blocked by rule: ${rule}\n` +
      `  This tool never discards local work. If you genuinely need this, run it yourself.`
    );
    this.name = 'DestructiveCommandError';
    this.rule = rule;
    this.args = args;
  }
}

/**
 * Commands that can lose committed or uncommitted work.
 * Each rule gets a plain-English name so the refusal message is useful.
 */
const DESTRUCTIVE_RULES = [
  {
    name: 'reset --hard / --merge / --keep (discards working-tree changes)',
    test: a => a[0] === 'reset' && a.some(x => ['--hard', '--merge', '--keep'].includes(x)),
  },
  {
    name: 'checkout --force (overwrites local modifications)',
    test: a => a[0] === 'checkout' && a.some(x => x === '-f' || x === '--force'),
  },
  {
    name: 'switch --force / --discard-changes',
    test: a => a[0] === 'switch' && a.some(x => ['-f', '--force', '--discard-changes'].includes(x)),
  },
  {
    name: 'clean (deletes untracked files)',
    test: a => a[0] === 'clean',
  },
  {
    name: 'push --force (rewrites remote history)',
    test: a => a[0] === 'push' && a.some(x => x === '-f' || x === '--force' || x.startsWith('--force-with-lease')),
  },
  {
    name: 'push --delete (removes a remote branch)',
    test: a => a[0] === 'push' && a.some(x => x === '-d' || x === '--delete'),
  },
  {
    name: 'branch -D / --delete --force (drops unmerged commits)',
    test: a => a[0] === 'branch' && a.some(x => x === '-D' || x === '--force'),
  },
  {
    name: 'branch --delete (may drop unmerged commits)',
    test: a => a[0] === 'branch' && a.some(x => x === '-d' || x === '--delete'),
  },
  {
    name: 'stash drop / clear / pop (destroys stashed work)',
    test: a => a[0] === 'stash' && ['drop', 'clear', 'pop'].includes(a[1]),
  },
  {
    name: 'gc / prune (collects unreachable objects)',
    test: a => a[0] === 'gc' || a[0] === 'prune' || (a[0] === 'remote' && a[1] === 'prune'),
  },
  {
    name: 'reflog expire (removes the recovery log)',
    test: a => a[0] === 'reflog' && a[1] === 'expire',
  },
  {
    name: 'update-ref -d (deletes a ref)',
    test: a => a[0] === 'update-ref' && a.includes('-d'),
  },
  {
    name: 'filter-branch / filter-repo (rewrites history)',
    test: a => a[0] === 'filter-branch' || a[0] === 'filter-repo',
  },
  {
    name: 'rebase (rewrites local commits)',
    test: a => a[0] === 'rebase' && !a.includes('--abort') && !a.includes('--quit'),
  },
  {
    name: 'commit --amend (rewrites the last commit)',
    test: a => a[0] === 'commit' && a.includes('--amend'),
  },
  {
    name: 'restore --worktree (overwrites working-tree files)',
    test: a => a[0] === 'restore' && (a.includes('-W') || a.includes('--worktree') ||
      // `git restore <path>` defaults to --worktree
      (!a.includes('--staged') && !a.includes('-S'))),
  },
  {
    name: 'checkout of paths (overwrites working-tree files)',
    test: a => a[0] === 'checkout' && a.includes('--'),
  },
  {
    name: 'submodule deinit --force (removes a submodule working tree)',
    test: a => a[0] === 'submodule' && a[1] === 'deinit',
  },
  {
    name: 'worktree remove (deletes a working tree)',
    test: a => a[0] === 'worktree' && a[1] === 'remove',
  },
];

/**
 * Config that turns off git's line-ending rewriting for a single command.
 *
 * Snapshot capture and restore must move bytes, not git's idea of them. Under
 * `core.autocrlf=true` — the Git for Windows installer default — `add` strips
 * CR on the way into a snapshot and `restore` writes CRLF back out, so a
 * round trip silently rewrites the line endings of every text file, including
 * ones deliberately kept as LF. `core.eol=lf` covers the same conversion when
 * it is driven by a `text` attribute instead of by autocrlf, since the default
 * (`native`) means CRLF on Windows.
 *
 * A repo that pins `eol=crlf` in .gitattributes still gets CRLF: that is an
 * explicit in-tree policy rather than an ambient machine setting.
 */
const EXACT_BYTES_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];

function assertSafe(args) {
  for (const rule of DESTRUCTIVE_RULES) {
    let hit = false;
    try {
      hit = rule.test(args);
    } catch {
      hit = false;
    }
    if (hit) throw new DestructiveCommandError(rule.name, args);
  }
}

/**
 * Run git synchronously and return trimmed stdout.
 *
 * opts.cwd            working directory (required in practice)
 * opts.allowFail      return {ok:false} instead of throwing
 * opts.allowDestructive  bypass the safety blocklist (one caller only)
 * opts.env            extra environment variables
 * opts.exactBytes     disable line-ending conversion (snapshot capture/restore)
 * opts.input          stdin
 */
function git(args, opts = {}) {
  if (!opts.allowDestructive) assertSafe(args);

  // Injected after assertSafe, never before: every blocklist rule matches on
  // args[0], so prepending flags to what it inspects would blind all of them.
  const argv = opts.exactBytes ? [...EXACT_BYTES_CONFIG, ...args] : args;

  const env = { ...process.env, ...(opts.env || {}) };
  // Keep git non-interactive: never pop a credential prompt or a pager mid-command.
  env.GIT_TERMINAL_PROMPT = env.GIT_TERMINAL_PROMPT ?? '0';
  env.GIT_PAGER = 'cat';
  env.GIT_OPTIONAL_LOCKS = '0';

  try {
    const out = execFileSync('git', argv, {
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
      input: opts.input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: opts.timeout || 120000,
    });
    return opts.raw ? out : out.trim();
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    if (opts.allowFail) return null;
    throw new GitError(
      `git ${args.join(' ')} failed in ${opts.cwd || process.cwd()}\n${stderr}`,
      { args, cwd: opts.cwd, stderr, code: err.status }
    );
  }
}

/** Run git and never throw: returns { ok, out, err }. */
function tryGit(args, opts = {}) {
  try {
    const out = git(args, opts);
    return { ok: true, out: out === null ? '' : out, err: '' };
  } catch (err) {
    if (err instanceof DestructiveCommandError) throw err;
    return { ok: false, out: '', err: err.stderr || err.message };
  }
}

/* ------------------------------------------------------------------ */
/* Common queries                                                      */
/* ------------------------------------------------------------------ */

function isRepo(cwd) {
  const r = tryGit(['rev-parse', '--is-inside-work-tree'], { cwd });
  return r.ok && r.out === 'true';
}

function repoRoot(cwd) {
  const r = tryGit(['rev-parse', '--show-toplevel'], { cwd });
  return r.ok ? r.out : null;
}

function headSha(cwd) {
  const r = tryGit(['rev-parse', 'HEAD'], { cwd });
  return r.ok ? r.out : null;
}

/** Current branch name, or null when HEAD is detached / repo is empty. */
function currentBranch(cwd) {
  const r = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  return r.ok && r.out ? r.out : null;
}

function isDetached(cwd) {
  return headSha(cwd) !== null && currentBranch(cwd) === null;
}

/** True when the repo has no commits yet. */
function isEmptyRepo(cwd) {
  return headSha(cwd) === null;
}

/**
 * Working-tree state. Counts are cheap and are what `status` renders.
 * Untracked files are counted separately because they are the ones users
 * most often lose.
 */
function worktreeState(cwd) {
  // raw: the first two columns are significant and a leading space on the first
  // line would be lost to trimming, turning " M file" into a staged change.
  const r = tryGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd, raw: true });
  if (!r.ok) return { clean: true, modified: 0, untracked: 0, staged: 0, conflicted: 0, total: 0 };
  const lines = r.out.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length > 0);
  let modified = 0, untracked = 0, staged = 0, conflicted = 0;
  for (const line of lines) {
    const x = line[0], y = line[1];
    if (x === '?' && y === '?') { untracked++; continue; }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { conflicted++; continue; }
    if (x !== ' ' && x !== '?') staged++;
    if (y !== ' ' && y !== '?') modified++;
  }
  const total = lines.length;
  return { clean: total === 0, modified, untracked, staged, conflicted, total };
}

/** Ahead/behind counts against an upstream, or null when there is no upstream. */
function aheadBehind(cwd, upstream) {
  const ref = upstream || tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd }).out;
  if (!ref) return null;
  const r = tryGit(['rev-list', '--left-right', '--count', `${ref}...HEAD`], { cwd });
  if (!r.ok) return null;
  const [behind, ahead] = r.out.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0, upstream: ref };
}

function commitExists(cwd, sha) {
  if (!sha) return false;
  return tryGit(['cat-file', '-e', `${sha}^{commit}`], { cwd }).ok;
}

/** True when `ancestor` is reachable from `descendant`. */
function isAncestor(cwd, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd, stdio: 'ignore', windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function refExists(cwd, ref) {
  return tryGit(['rev-parse', '--verify', '--quiet', ref], { cwd }).ok;
}

function resolveRef(cwd, ref) {
  const r = tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  return r.ok && r.out ? r.out : null;
}

/** Short one-line description of a commit, for display. */
function describeCommit(cwd, sha) {
  const r = tryGit(['log', '-1', '--format=%h %s', sha], { cwd });
  return r.ok ? r.out : sha ? sha.slice(0, 8) : '(none)';
}

function commitMeta(cwd, sha) {
  const r = tryGit(['log', '-1', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s', sha], { cwd });
  if (!r.ok) return null;
  const [full, short, author, date, subject] = r.out.split('\x1f');
  return { sha: full, short, author, date, subject };
}

/**
 * Submodule gitlinks recorded in a tree (default: HEAD).
 * Returns [{ path, sha }] — mode 160000 entries only.
 */
function gitlinksInTree(cwd, treeish = 'HEAD') {
  const r = tryGit(['ls-tree', '-r', '-z', treeish], { cwd });
  if (!r.ok) return [];
  return r.out
    .split('\0')
    .filter(Boolean)
    .map(entry => {
      const tab = entry.indexOf('\t');
      const meta = entry.slice(0, tab).split(/\s+/);
      return { mode: meta[0], type: meta[1], sha: meta[2], path: entry.slice(tab + 1) };
    })
    .filter(e => e.mode === '160000')
    .map(e => ({ path: e.path, sha: e.sha }));
}

/** Submodule gitlinks currently staged in the index. */
function gitlinksInIndex(cwd) {
  const r = tryGit(['ls-files', '--stage', '-z'], { cwd });
  if (!r.ok) return [];
  return r.out
    .split('\0')
    .filter(Boolean)
    .map(entry => {
      const tab = entry.indexOf('\t');
      const meta = entry.slice(0, tab).split(/\s+/);
      return { mode: meta[0], sha: meta[1], path: entry.slice(tab + 1) };
    })
    .filter(e => e.mode === '160000')
    .map(e => ({ path: e.path, sha: e.sha }));
}

/** Parse .gitmodules into [{ name, path, url, branch }]. */
function parseGitmodules(cwd) {
  const r = tryGit(['config', '--file', '.gitmodules', '--list'], { cwd });
  if (!r.ok || !r.out) return [];
  const byName = new Map();
  for (const line of r.out.split('\n')) {
    const m = line.match(/^submodule\.(.+)\.(path|url|branch)=(.*)$/);
    if (!m) continue;
    const [, name, key, value] = m;
    if (!byName.has(name)) byName.set(name, { name });
    byName.get(name)[key] = value;
  }
  return [...byName.values()];
}

function remoteUrl(cwd, remote = 'origin') {
  const r = tryGit(['remote', 'get-url', remote], { cwd });
  return r.ok ? r.out : null;
}

function listRefs(cwd, pattern) {
  // for-each-ref has its own format language and does NOT understand %xXX
  // escapes, so the delimiter is passed as a literal control character.
  const SEP = '\x1f';
  const r = tryGit(
    ['for-each-ref', `--format=%(refname)${SEP}%(objectname)${SEP}%(creatordate:iso-strict)`, pattern],
    { cwd }
  );
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').filter(Boolean).map(line => {
    const [refname, objectname, date] = line.split(SEP);
    return { ref: refname, sha: objectname, date };
  });
}

module.exports = {
  git,
  tryGit,
  assertSafe,
  GitError,
  DestructiveCommandError,
  DESTRUCTIVE_RULES,
  isRepo,
  repoRoot,
  headSha,
  currentBranch,
  isDetached,
  isEmptyRepo,
  worktreeState,
  aheadBehind,
  commitExists,
  isAncestor,
  refExists,
  resolveRef,
  describeCommit,
  commitMeta,
  gitlinksInTree,
  gitlinksInIndex,
  parseGitmodules,
  remoteUrl,
  listRefs,
};
