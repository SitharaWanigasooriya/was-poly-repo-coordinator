'use strict';
/**
 * poly land — bump submodule pointers to what actually landed, in dependency
 * order, and commit the superproject only if Gate 1 passes.
 *
 * This is a pointer-bumper, not a merge tool. It assumes each member change is
 * already merged into its protected branch. For every member in scope it:
 *   1. fetches the protected branch
 *   2. checks the target commit is a real forward move (Gate 1's own predicates)
 *   3. fast-forwards the submodule checkout to it
 *   4. stages the new gitlink
 * Then it runs Gate 1 against the staged state. If anything is at error
 * severity it stops without committing, leaving the staged bumps and a
 * pre-land snapshot. Otherwise it makes one commit.
 *
 * It never runs `git merge` on a member's work branch and never touches PRs.
 * There is no --keep-going: a half-landed change set is the exact state this
 * tool exists to keep survivable, so it stops on the first blocker.
 */

const m = require('../manifest');
const g = require('../git');
const policy = require('../policy');
const safety = require('../safety');
const graph = require('../graph');
const pins = require('../pins');
const cs = require('../changeset');
const { c, sym, ok, bad, warn, info, table, plural, indent } = require('../ui');

/** Paths with pending changes in the superproject working tree. */
function dirtyPaths(root) {
  const r = g.tryGit(['status', '--porcelain=v1', '-z', '--untracked-files=no'], { cwd: root, raw: true });
  if (!r.ok || !r.out) return [];
  return r.out.split('\0').filter(Boolean).map(line => line.slice(3));
}

/**
 * Read-only pass: work out what each member's pointer should become and collect
 * any reason we must not proceed.
 */
function planMember(ws, member, record) {
  const d = { name: member.name, path: member.path, from: null, to: null, action: null, blocker: null, note: null };

  const current = g.gitlinksInIndex(ws.root).find(l => l.path === member.path);
  d.from = current ? current.sha : null;

  if (!member.present) {
    d.blocker = `not checked out — run: git submodule update --init -- ${member.path}`;
    return d;
  }

  g.tryGit(['fetch', member.remote || 'origin', member.protectedBranch], { cwd: member.absPath, timeout: 180000 });

  const protectedRef = policy.resolveProtectedRef(member.absPath, member);
  if (!protectedRef) {
    d.blocker = `no ${member.remote || 'origin'}/${member.protectedBranch} and no local ${member.protectedBranch} — cannot tell what "landed" means`;
    return d;
  }
  const target = protectedRef.sha;
  d.to = target;

  const entry = record && record.members.find(e => e.name === member.name);
  if (entry && entry.landedSha && entry.landedSha !== target) {
    d.blocker =
      `change set recorded ${entry.landedSha.slice(0, 10)} as landed, but ${member.protectedBranch} ` +
      `is now at ${target.slice(0, 10)}. Run: poly changeset track ${record.id}`;
    return d;
  }
  if (entry && !entry.merged) {
    d.blocker = `change set says this member has not merged yet. Run: poly changeset track ${record.id}`;
    return d;
  }

  if (!g.commitExists(member.absPath, target)) {
    d.blocker = `${member.protectedBranch} resolves to ${target.slice(0, 10)}, which is not in the repo after fetch`;
    return d;
  }

  if (d.from && d.from === target) {
    d.action = 'unchanged';
    d.note = 'already at the protected-branch tip';
    return d;
  }

  if (d.from && !g.isAncestor(member.absPath, d.from, target)) {
    // The current pointer is not an ancestor of the target: either a regression
    // or a divergence. Gate 1 would reject the commit, so refuse now.
    if (g.isAncestor(member.absPath, target, d.from)) {
      d.blocker = `would move the pointer backwards (${d.from.slice(0, 10)} → ${target.slice(0, 10)})`;
    } else {
      d.blocker = `current pointer ${d.from.slice(0, 10)} and ${member.protectedBranch} have diverged — resolve by hand`;
    }
    return d;
  }

  if (!g.worktreeState(member.absPath).clean) {
    d.blocker = `has uncommitted changes — commit or stash them first (the pre-land snapshot holds a copy)`;
    return d;
  }

  d.action = 'bump';
  return d;
}

/** Fast-forward one submodule checkout onto its protected branch. */
function applyMember(member) {
  const cwd = member.absPath;
  const branch = member.protectedBranch;
  const remoteRef = `${member.remote || 'origin'}/${branch}`;

  const co = g.tryGit(['checkout', branch], { cwd });
  if (!co.ok) return { ok: false, error: `checkout ${branch}: ${co.err.split('\n')[0]}` };

  if (g.refExists(cwd, `refs/remotes/${remoteRef}`)) {
    const ff = g.tryGit(['merge', '--ff-only', remoteRef], { cwd });
    if (!ff.ok) {
      return { ok: false, error: `${branch} has local commits that are not on ${remoteRef} — cannot fast-forward` };
    }
  }
  return { ok: true, sha: g.headSha(cwd) };
}

function commitMessage(bumps, record) {
  const lines = [`poly land: bump ${plural(bumps.length, 'submodule pointer')}`, ''];
  for (const b of bumps) {
    lines.push(`- ${b.name}: ${b.to.slice(0, 10)}${b.subject ? ` ${b.subject}` : ''}`);
  }
  if (record) {
    lines.push('', `Changeset: ${record.id} — ${record.title}`);
  }
  return lines.join('\n') + '\n';
}

async function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd, { requireManifest: true });

  // --- scope ---
  let record = null;
  if (args.flags.changeset) {
    try {
      record = cs.read(ws.root, args.flags.changeset);
    } catch (err) {
      console.error(err.message);
      return 2;
    }
    if (!record) {
      console.error(`No change set matching "${args.flags.changeset}".`);
      return 2;
    }
  }

  const indexLinks = new Set(g.gitlinksInIndex(ws.root).map(l => l.path));
  let scoped = ws.members.filter(mem => indexLinks.has(mem.path));
  if (record) {
    const wanted = new Set(record.members.map(e => e.name));
    scoped = scoped.filter(mem => wanted.has(mem.name));
  }

  if (!scoped.length) {
    console.error(record ? 'None of the change set members have a gitlink in this superproject.' : 'No submodule pointers to land.');
    return 2;
  }

  const dryRun = !!args.flags['dry-run'];

  if (!dryRun && g.isDetached(ws.root)) {
    console.error('The superproject is on a detached HEAD. Check out a branch before landing.');
    return 2;
  }

  // --- superproject must be clean except for the gitlinks we will touch ---
  const scopedPaths = new Set(scoped.map(s => s.path));
  const stray = dirtyPaths(ws.root).filter(p => !scopedPaths.has(p));
  if (stray.length && !args.flags.force) {
    console.error('The superproject has uncommitted changes that are not part of this land:');
    for (const p of stray.slice(0, 10)) console.error(`  ${p}`);
    console.error('Commit or stash them, or re-run with --force.');
    return 2;
  }

  // --- safety net before anything moves ---
  let snap = null;
  if (!dryRun) {
    try {
      snap = safety.guard(ws, `before land${record ? ` ${record.id}` : ''}`);
    } catch (err) {
      console.error(err.message);
      return 1;
    }
  }

  // --- order ---
  let order, unknownDeps;
  try {
    ({ order, unknownDeps } = graph.topoSort(scoped));
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  // --- read-only plan ---
  const plans = order.map(mem => planMember(ws, mem, record));
  const blocked = plans.filter(p => p.blocker);

  if (!ctx.json) {
    console.log();
    if (snap) console.log(`  ${c.grey('safety snapshot')} ${c.bold(snap.id)}\n`);
    console.log(table(
      [
        { key: 'name', header: 'MEMBER' },
        { key: 'move', header: 'POINTER' },
        { key: 'verdict', header: '' },
      ],
      plans.map(p => ({
        name: c.bold(p.name),
        move: c.grey(`${p.from ? p.from.slice(0, 10) : '—'} ${sym.arrow} ${p.to ? p.to.slice(0, 10) : '?'}`),
        verdict: p.blocker ? c.red(`${sym.bad} ${p.blocker}`)
          : p.action === 'unchanged' ? c.grey(`${sym.info} ${p.note}`)
          : c.green(`${sym.ok} ready`),
      })),
      { indent: '  ' }
    ));
    for (const u of unknownDeps) {
      console.log(`  ${warn(`${u.member}: dependsOn names unknown member(s): ${u.missing.join(', ')}`)}`);
    }
    console.log();
  }

  if (blocked.length) {
    if (ctx.json) {
      console.log(JSON.stringify({ snapshot: snap && snap.id, dryRun, plans, committed: false }, null, 2));
    } else {
      console.log(`  ${bad(`${plural(blocked.length, 'member')} not ready — nothing was committed`)}`);
      if (snap) console.log(`  ${c.grey(`your work before this is in snapshot ${snap.id}`)}`);
      console.log();
    }
    return 1;
  }

  const bumps = plans.filter(p => p.action === 'bump');

  if (dryRun) {
    if (ctx.json) {
      console.log(JSON.stringify({ dryRun: true, plans, wouldCommit: bumps.length > 0 }, null, 2));
    } else if (bumps.length) {
      console.log(`  ${ok(`${plural(bumps.length, 'pointer')} would be bumped`)} ${c.grey('— re-run without --dry-run')}`);
      console.log();
    } else {
      console.log(`  ${c.grey('nothing to land — every pointer is already current')}`);
      console.log();
    }
    return 0;
  }

  if (!bumps.length) {
    if (ctx.json) console.log(JSON.stringify({ snapshot: snap.id, plans, committed: false, reason: 'nothing to land' }, null, 2));
    else { console.log(`  ${c.grey('nothing to land — every pointer is already current')}`); console.log(); }
    return 0;
  }

  // --- apply ---
  const applied = [];
  for (const b of bumps) {
    const member = order.find(o => o.name === b.name);
    const res = applyMember(member);
    if (!res.ok) {
      if (!ctx.json) {
        console.log(`  ${bad(`${b.name}: ${res.error}`)}`);
        console.log(`  ${c.grey(`stopped. staged so far: ${applied.map(a => a.name).join(', ') || 'none'}. snapshot ${snap.id}`)}`);
        console.log();
      } else {
        console.log(JSON.stringify({ snapshot: snap.id, plans, applied, committed: false, error: `${b.name}: ${res.error}` }, null, 2));
      }
      return 1;
    }
    b.to = res.sha || b.to;
    b.subject = (g.commitMeta(member.absPath, b.to) || {}).subject || null;
    const add = g.tryGit(['add', '--', member.path], { cwd: ws.root });
    if (!add.ok) {
      if (!ctx.json) console.log(`  ${bad(`could not stage ${member.path}: ${add.err.split('\n')[0]}`)}`);
      else console.log(JSON.stringify({ snapshot: snap.id, applied, committed: false, error: add.err }, null, 2));
      return 1;
    }
    applied.push(b);
  }

  // --- Gate 1 on the staged result ---
  const gate = policy.gate1(ws, { treeish: 'INDEX' });
  const gateErrors = gate.findings.filter(f => f.severity === 'error');

  if (gateErrors.length) {
    if (ctx.json) {
      console.log(JSON.stringify({ snapshot: snap.id, applied, gate: gateErrors, committed: false }, null, 2));
    } else {
      console.log(`  ${bad('Gate 1 rejected the staged bump — not committing')}`);
      for (const f of gateErrors) {
        console.log(`  ${bad(f.title)} ${c.grey(`[${f.invariant}]`)}`);
        console.log(indent(c.grey(f.detail), '      '));
      }
      console.log();
      console.log(`  ${c.grey(`the bumps are staged but uncommitted. undo with:  poly restore ${snap.id} --apply`)}`);
      console.log();
    }
    return 1;
  }

  if (args.flags['no-commit']) {
    if (ctx.json) console.log(JSON.stringify({ snapshot: snap.id, applied, gate: 'pass', committed: false }, null, 2));
    else {
      console.log(`  ${ok(`${plural(applied.length, 'pointer')} staged, Gate 1 passes`)}`);
      console.log(`  ${c.grey('--no-commit set — commit it yourself when ready')}`);
      console.log();
    }
    return 0;
  }

  // --- commit ---
  const msg = args.flags.message || commitMessage(applied, record);
  const commit = g.tryGit(['commit', '-m', msg], { cwd: ws.root });
  if (!commit.ok) {
    if (!ctx.json) console.log(`  ${bad(`commit failed: ${commit.err.split('\n')[0]}`)}`);
    else console.log(JSON.stringify({ snapshot: snap.id, applied, committed: false, error: commit.err }, null, 2));
    return 1;
  }
  const commitSha = g.headSha(ws.root);

  // --- optional pin + changeset bookkeeping ---
  let pinResults = null;
  if (args.flags.pin || args.flags['pin-push']) {
    pinResults = pins.pinAll(ws, { members: applied.map(a => a.name), push: !!args.flags['pin-push'] });
  }
  if (record) {
    cs.refresh(ws, record);
    cs.markLanded(ws.root, record, commitSha);
  }

  if (ctx.json) {
    console.log(JSON.stringify({
      snapshot: snap.id, applied, gate: 'pass', committed: true, commit: commitSha,
      pins: pinResults, changeset: record ? record.id : null,
    }, null, 2));
    return 0;
  }

  console.log(`  ${ok(`landed ${plural(applied.length, 'pointer')} in ${c.bold(commitSha.slice(0, 10))}`)}`);
  if (pinResults) {
    const pinned = pinResults.filter(p => p.ok && !p.already).length;
    console.log(`  ${c.grey(`pinned ${pinned} new commit(s)${args.flags['pin-push'] ? ', pushed' : ''}`)}`);
  }
  if (record) console.log(`  ${c.grey(`change set ${record.id} marked landed`)}`);
  console.log(`  ${c.grey(`push the superproject when ready. undo everything with:  poly restore ${snap.id} --apply`)}`);
  console.log();
  return 0;
}

module.exports = {
  run,
  help: {
    usage: 'poly land [--changeset <id>] [--dry-run] [--no-commit] [--pin] [--message <m>]',
    summary: 'Bump submodule pointers to what landed, in order, then commit if Gate 1 passes',
    detail: [
      'A pointer-bumper, not a merge tool: every member change must already be',
      'merged into its protected branch. For each member in dependsOn order poly',
      'fetches, checks the move is a real fast-forward, fast-forwards the submodule',
      'checkout, and stages the gitlink. Then it runs Gate 1 and commits only if',
      'nothing is at error severity.',
      '',
      'Takes a safety snapshot first. Stops on the first blocker — there is no',
      '--keep-going, because a half-landed change set is what the snapshot is for.',
      '',
      '  --changeset <id>  land only that change set\'s members, and mark it landed',
      '  --dry-run         show the plan, touch nothing',
      '  --no-commit       stage the bumps and stop before the commit',
      '  --pin             pin each landed commit (add --pin-push to publish)',
      '  --message <m>     override the generated commit message',
      '  --force           proceed even if the superproject has unrelated changes',
    ].join('\n'),
  },
};
