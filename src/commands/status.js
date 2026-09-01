'use strict';
/** poly status — one screen showing where every repo stands. Read-only. */

const m = require('../manifest');
const g = require('../git');
const policy = require('../policy');
const safety = require('../safety');
const { c, sym, ok, bad, warn, info, table, heading, relTime, plural } = require('../ui');

function worktreeLabel(state) {
  if (!state) return c.grey('—');
  if (state.clean) return c.grey('clean');
  const bits = [];
  if (state.staged) bits.push(`${state.staged} staged`);
  if (state.modified) bits.push(`${state.modified} modified`);
  if (state.untracked) bits.push(`${state.untracked} untracked`);
  if (state.conflicted) bits.push(c.red(`${state.conflicted} conflicted`));
  return c.yellow(bits.join(', '));
}

function pointerLabel(row) {
  switch (row.status) {
    case 'ok': return c.green(`${sym.ok} merged`);
    case 'broken': return c.red(`${sym.bad} commit missing`);
    case 'unmerged': return c.red(`${sym.bad} not merged`);
    case 'regression': return c.red(`${sym.bad} moves backwards`);
    case 'missing': return c.yellow(`${sym.warn} no gitlink`);
    case 'unchecked': return c.grey(`? ${row.notes[0] || 'unverified'}`);
    default: return c.grey('—');
  }
}

function branchLabel(repoPath) {
  if (g.isEmptyRepo(repoPath)) return c.grey('(no commits)');
  const branch = g.currentBranch(repoPath);
  if (!branch) return c.red('(detached)');
  const ab = g.aheadBehind(repoPath);
  if (!ab) return branch + c.grey(' (no upstream)');
  let suffix = '';
  if (ab.ahead) suffix += c.cyan(` ${sym.arrow}${ab.ahead}`);
  if (ab.behind) suffix += c.magenta(` ${ab.behind}${sym.arrow}`);
  return branch + suffix;
}

/**
 * Is the superproject on a feature branch that would fast-forward cleanly onto
 * its protected branch? If so, `poly land --self` is the next move. Read-only.
 */
function selfLandHint(ws) {
  const pb = ws.manifest.defaults.protectedBranch;
  const branch = g.currentBranch(ws.root);
  if (!branch || branch === pb || g.isEmptyRepo(ws.root)) return null;
  const lp = g.resolveRef(ws.root, `refs/heads/${pb}`);
  const head = g.headSha(ws.root);
  if (!lp || lp === head || !g.isAncestor(ws.root, lp, head)) return null;
  const ahead = Number(g.tryGit(['rev-list', '--count', `${lp}..${head}`], { cwd: ws.root }).out || 0);
  return { branch, protectedBranch: pb, ahead };
}

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd);
  const result = policy.checkAll(ws, { treeish: 'INDEX' });
  const counts = policy.summarise(result.findings);
  const snapshots = safety.listSnapshots(ws);
  const rootState = g.worktreeState(ws.root);
  const selfLand = selfLandHint(ws);

  if (ctx.json) {
    console.log(JSON.stringify({
      root: ws.root,
      name: ws.name,
      hasManifest: ws.hasManifest,
      superproject: {
        branch: g.currentBranch(ws.root),
        detached: g.isDetached(ws.root),
        head: g.headSha(ws.root),
        worktree: rootState,
        readyToLandSelf: selfLand ? { protectedBranch: selfLand.protectedBranch, ahead: selfLand.ahead } : null,
      },
      members: ws.members.map(mem => {
        const row = result.rows.find(r => r.path === mem.path);
        return {
          name: mem.name,
          path: mem.path,
          present: mem.present,
          branch: mem.present ? g.currentBranch(mem.absPath) : null,
          detached: mem.present ? g.isDetached(mem.absPath) : null,
          worktree: mem.present ? g.worktreeState(mem.absPath) : null,
          pointer: row ? row.pointer : null,
          pointerStatus: row ? row.status : null,
        };
      }),
      findings: result.findings,
      counts,
      latestSnapshot: snapshots[0] ? { id: snapshots[0].id, when: snapshots[0].when } : null,
    }, null, 2));
    return counts.errors ? 1 : 0;
  }

  // --- superproject ---
  console.log();
  console.log(`  ${c.bold(ws.name)}  ${c.grey(ws.root)}`);
  console.log(`  ${c.grey('branch')}  ${branchLabel(ws.root)}   ${worktreeLabel(rootState)}`);
  if (!ws.hasManifest) {
    console.log(`  ${warn(`no ${m.MANIFEST_NAME} — showing discovered submodules. Run "poly init" to make policy stick.`)}`);
  }

  // --- members ---
  if (ws.members.length === 0) {
    console.log();
    console.log(info('No submodules in this repository.'));
    return 0;
  }

  const rows = ws.members.map(mem => {
    const row = result.rows.find(r => r.path === mem.path) || { status: 'unchecked', notes: [] };
    if (!mem.present) {
      return {
        name: c.bold(mem.name),
        branch: c.grey('not checked out'),
        worktree: c.grey('—'),
        pointer: c.grey('?'),
      };
    }
    return {
      name: c.bold(mem.name),
      branch: branchLabel(mem.absPath),
      worktree: worktreeLabel(g.worktreeState(mem.absPath)),
      pointer: pointerLabel(row),
    };
  });

  console.log(heading(`  ${plural(ws.members.length, 'member')}`));
  console.log(table(
    [
      { key: 'name', header: 'MEMBER' },
      { key: 'branch', header: 'BRANCH' },
      { key: 'worktree', header: 'WORKTREE' },
      { key: 'pointer', header: 'POINTER' },
    ],
    rows,
    { indent: '  ' }
  ));

  // --- headline findings ---
  const errors = result.findings.filter(f => f.severity === 'error');
  const warnings = result.findings.filter(f => f.severity === 'warn');

  if (errors.length) {
    console.log(heading(`  ${c.red(plural(errors.length, 'problem'))}`));
    for (const f of errors.slice(0, 5)) console.log(`  ${bad(f.title)}`);
    if (errors.length > 5) console.log(c.grey(`    …and ${errors.length - 5} more`));
  }
  if (warnings.length && !errors.length) {
    console.log(heading(`  ${c.yellow(plural(warnings.length, 'warning'))}`));
    for (const f of warnings.slice(0, 5)) console.log(`  ${warn(f.title)}`);
    if (warnings.length > 5) console.log(c.grey(`    …and ${warnings.length - 5} more`));
  }

  // --- safety net ---
  console.log();
  const dirty = [ws.root, ...ws.members.filter(x => x.present).map(x => x.absPath)]
    .filter(p => !g.worktreeState(p).clean).length;

  if (snapshots.length) {
    const latest = snapshots[0];
    console.log(`  ${c.green(sym.ok)} ${c.grey('safety net:')} last snapshot ${c.bold(relTime(latest.when))} ${c.grey(`(${latest.id})`)}`);
  } else {
    console.log(`  ${c.grey(`${sym.info} safety net: no snapshots yet`)}`);
  }
  if (dirty) {
    console.log(`    ${c.grey(`${dirty} repo(s) have uncommitted work —`)} ${c.bold('poly save')} ${c.grey('makes it restorable')}`);
  }

  // row.pinned is already computed by gate1 (checkAll) — no extra git calls here.
  const pinnable = result.rows.filter(r => r.pinned !== undefined);
  const pinned = pinnable.filter(r => r.pinned).length;
  if (pinnable.length && pinned < pinnable.length) {
    console.log(`    ${c.grey(`${pinned}/${pinnable.length} pointers pinned —`)} ${c.bold('poly pin')} ${c.grey('makes them durable')}`);
  }

  if (errors.length || warnings.length) {
    console.log(`    ${c.grey('run')} ${c.bold('poly doctor')} ${c.grey('for detail and suggested fixes')}`);
  }
  if (selfLand && !errors.length) {
    console.log(`    ${c.grey(`${selfLand.branch} is ${plural(selfLand.ahead, 'commit')} ahead of ${selfLand.protectedBranch} —`)} ${c.bold('poly land --self')} ${c.grey('fast-forwards it')}`);
  }
  console.log();

  return errors.length ? 1 : 0;
}

module.exports = {
  run,
  aliases: ['st', 's'],
  help: {
    usage: 'poly status [--json]',
    summary: 'Where every repo stands: branch, uncommitted work, pointer health',
    detail: [
      'Read-only. Shows the superproject, every member repo, and whether each',
      'submodule pointer is safely merged into its protected branch.',
      '',
      'Exit code 1 if there is anything at error severity.',
    ].join('\n'),
  },
};
