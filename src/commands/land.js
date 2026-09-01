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

const fs = require('fs');
const path = require('path');

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
  if (args.flags.self) return runSelf(args, ctx);

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

/** Durable anchors written by each successful `land --self` and consumed by
 *  `--undo`: `/from` is where the branch was (the walk-back target), `/onto` is
 *  where `land --self` moved it (so `--undo` can tell nothing new has landed
 *  since). Being refs they are gc-proof, unlike the reflog. */
function landUndoRefs(protectedBranch) {
  return {
    from: `refs/poly/land/${protectedBranch}/from`,
    onto: `refs/poly/land/${protectedBranch}/onto`,
  };
}

/** Same filesystem location? Resolves 8.3 short names, symlinks and slash style
 *  (git and Node can report a path in different forms), case-folded for Windows. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = p => {
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
  };
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** Path of another worktree that has `branch` checked out, or null. Moving a
 *  branch ref out from under a live worktree desyncs it, and poly's own safety
 *  list would block the `branch --force` that git uses to guard against it. */
function branchCheckedOutElsewhere(root, branch) {
  const r = g.tryGit(['worktree', 'list', '--porcelain'], { cwd: root });
  if (!r.ok || !r.out) return null;
  const self = g.repoRoot(root) || root; // git-canonical form, matches worktree list
  for (const block of r.out.split(/\n\n+/)) {
    const lines = block.split('\n');
    const wt = (lines.find(l => l.startsWith('worktree ')) || '').slice(9);
    const br = (lines.find(l => l.startsWith('branch ')) || '').slice(7);
    if (br === `refs/heads/${branch}` && wt && !samePath(wt, self)) return wt;
  }
  return null;
}

/**
 * poly land --self — fast-forward the superproject's OWN protected branch to the
 * branch you are on. The sibling of the pointer-bump above: once the bump commit
 * (or any superproject work) is on a feature branch and Gate 1 is green, this
 * moves `main` up to it.
 *
 * It only ever fast-forwards — never a rewrite, never a merge that can conflict.
 * The move is a single ref update: no checkout unless --switch, no merge commit.
 * The before/after positions are saved under refs/poly/land/<branch>/ so `--undo`
 * can walk it back, and a safety snapshot is taken first.
 */
async function runSelf(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd, { requireManifest: true });
  const root = ws.root;
  const dryRun = !!args.flags['dry-run'];
  const force = !!args.flags.force;
  const verify = args.flags.verify !== false && !args.flags['no-verify'];

  if (g.isEmptyRepo(root)) {
    console.error('The superproject has no commits yet — nothing to land.');
    return 2;
  }

  const protectedBranch = ws.manifest.defaults.protectedBranch;
  const remote = ws.manifest.defaults.remote;

  if (args.flags.undo) return undoSelf(args, ctx, ws, { protectedBranch, remote, dryRun });

  const branch = g.currentBranch(root);
  if (!branch) {
    console.error('The superproject is on a detached HEAD. Check out the branch you want to land.');
    return 2;
  }
  if (branch === protectedBranch) {
    console.error(`Already on ${protectedBranch}. Check out the feature branch you want to land onto it.`);
    return 2;
  }

  // --- optional change set: scope + bookkeeping ---
  let record = null;
  if (args.flags.changeset) {
    try {
      record = cs.read(root, args.flags.changeset);
    } catch (err) {
      console.error(err.message);
      return 2;
    }
    if (!record) {
      console.error(`No change set matching "${args.flags.changeset}".`);
      return 2;
    }
  }

  const elsewhere = branchCheckedOutElsewhere(root, protectedBranch);
  if (elsewhere) {
    console.error(`${protectedBranch} is checked out in another worktree:\n  ${elsewhere}\nLand from there, or with that worktree closed.`);
    return 2;
  }

  // Tracked changes would be stranded by the branch move (they belong to no
  // commit yet); untracked files are harmless and ignored — the line `land`
  // itself draws.
  const dirty = dirtyPaths(root);
  if (dirty.length && !force) {
    console.error(`The superproject has uncommitted changes to ${plural(dirty.length, 'tracked file')}:`);
    for (const p of dirty.slice(0, 10)) console.error(`  ${p}`);
    console.error('Commit or stash them first, or re-run with --force (the pre-land snapshot keeps a copy).');
    return 2;
  }

  // --- safety net before anything moves ---
  let snap = null;
  if (!dryRun) {
    try {
      snap = safety.guard(ws, `before land --self ${branch} ${sym.arrow} ${protectedBranch}`);
    } catch (err) {
      console.error(err.message);
      return 1;
    }
  }

  g.tryGit(['fetch', remote, protectedBranch], { cwd: root, timeout: 180000 });

  const head = g.headSha(root);
  const localProtected = g.resolveRef(root, `refs/heads/${protectedBranch}`);
  const remoteProtected = g.resolveRef(root, `refs/remotes/${remote}/${protectedBranch}`);

  // --- change set: every member must actually have merged ---
  if (record && !force) {
    cs.refresh(ws, record);
    const pending = record.members.filter(e => !e.merged).map(e => e.name);
    if (pending.length) {
      if (ctx.json) {
        console.log(JSON.stringify({ snapshot: snap && snap.id, branch, protectedBranch, changeset: record.id, pending, landed: false }, null, 2));
      } else {
        console.log();
        console.log(`  ${bad(`change set ${record.id} has ${plural(pending.length, 'member')} not merged yet: ${pending.join(', ')}`)}`);
        console.log(`  ${c.grey(`run: poly changeset track ${record.id}   (or --force to land regardless)`)}`);
        console.log();
      }
      return 1;
    }
  }

  // --- Gate 1 on the commit that would become the protected-branch tip ---
  const gate = verify ? policy.gate1(ws, { treeish: 'HEAD' }) : { findings: [] };
  const gateErrors = gate.findings.filter(f => f.severity === 'error');
  if (gateErrors.length) {
    if (ctx.json) {
      console.log(JSON.stringify({ snapshot: snap && snap.id, branch, protectedBranch, gate: gateErrors, landed: false }, null, 2));
    } else {
      console.log();
      console.log(`  ${bad('Gate 1 rejected the current commit — not landing')}`);
      for (const f of gateErrors) {
        console.log(`  ${bad(f.title)} ${c.grey(`[${f.invariant}]`)}`);
        console.log(indent(c.grey(f.detail), '      '));
      }
      console.log();
      console.log(`  ${c.grey('fix the pointers, or re-run with --no-verify to land anyway')}`);
      console.log();
    }
    return 1;
  }

  if (localProtected === head) {
    if (ctx.json) console.log(JSON.stringify({ branch, protectedBranch, landed: false, reason: 'nothing to land' }, null, 2));
    else console.log(`\n  ${c.grey(`${protectedBranch} already points at ${branch} — nothing to land`)}\n`);
    return 0;
  }

  // --- fast-forward safety: the move must lose nothing ---
  if (localProtected && g.isAncestor(root, head, localProtected)) {
    if (ctx.json) console.log(JSON.stringify({ branch, protectedBranch, landed: false, reason: 'behind' }, null, 2));
    else console.log(`\n  ${c.grey(`${protectedBranch} is already ahead of ${branch} — nothing to land`)}\n`);
    return 0;
  }
  const blockers = [];
  if (localProtected && !g.isAncestor(root, localProtected, head)) {
    blockers.push(`${branch} and ${protectedBranch} have diverged. Merge ${protectedBranch} into ${branch} yourself, then re-run.`);
  }
  if (remoteProtected && !g.isAncestor(root, remoteProtected, head)) {
    blockers.push(`${remote}/${protectedBranch} has commits ${branch} does not. Run: poly sync --pull (on ${protectedBranch}), or merge it into ${branch}.`);
  }
  if (blockers.length) {
    if (ctx.json) {
      console.log(JSON.stringify({ snapshot: snap && snap.id, branch, protectedBranch, landed: false, blockers }, null, 2));
    } else {
      console.log();
      console.log(`  ${bad('not a fast-forward — nothing was changed')}`);
      for (const b of blockers) console.log(`  ${warn(b)}`);
      if (snap) console.log(`  ${c.grey(`your work is in snapshot ${snap.id}`)}`);
      console.log();
    }
    return 1;
  }

  const commitCount = Number(
    g.tryGit(['rev-list', '--count', localProtected ? `${localProtected}..${head}` : head], { cwd: root }).out || 0
  );

  if (dryRun) {
    if (ctx.json) {
      console.log(JSON.stringify({
        dryRun: true, branch, protectedBranch,
        from: localProtected, to: head, commits: commitCount,
        gate: verify ? 'pass' : 'skipped', changeset: record ? record.id : null, wouldLand: true,
      }, null, 2));
    } else {
      console.log();
      console.log(`  ${c.bold(branch)} ${sym.arrow} ${c.bold(protectedBranch)}   ${c.grey(`${localProtected ? localProtected.slice(0, 10) : '—'} ${sym.arrow} ${head.slice(0, 10)}`)}`);
      console.log(`  ${ok(`${plural(commitCount, 'commit')} would fast-forward`)} ${c.grey('— re-run without --dry-run')}`);
      if (record) console.log(`  ${c.grey(`change set ${record.id} would be marked landed`)}`);
      console.log();
    }
    return 0;
  }

  const updateArgs = ['update-ref', '-m', `poly land --self: ${branch} -> ${protectedBranch}`, `refs/heads/${protectedBranch}`, head];
  if (localProtected) updateArgs.push(localProtected); // atomic guard: fails if it moved under us
  const upd = g.tryGit(updateArgs, { cwd: root });
  if (!upd.ok) {
    if (ctx.json) console.log(JSON.stringify({ snapshot: snap.id, branch, protectedBranch, landed: false, error: upd.err }, null, 2));
    else {
      console.log(`\n  ${bad(`could not move ${protectedBranch}: ${upd.err.split('\n')[0]}`)}`);
      console.log(`  ${c.grey(`nothing was changed. snapshot ${snap.id}`)}\n`);
    }
    return 1;
  }

  // Record where the branch was and where it now is, so `--undo` has a durable,
  // unambiguous anchor. Only meaningful when there was a prior position.
  const undoRefs = landUndoRefs(protectedBranch);
  if (localProtected) {
    g.tryGit(['update-ref', undoRefs.from, localProtected], { cwd: root });
    g.tryGit(['update-ref', undoRefs.onto, head], { cwd: root });
  }

  let switched = false;
  if (args.flags.switch) {
    const co = g.tryGit(['checkout', protectedBranch], { cwd: root });
    switched = co.ok;
    if (!co.ok && !ctx.json) console.log(`  ${warn(`landed, but could not switch to ${protectedBranch}: ${co.err.split('\n')[0]}`)}`);
  }

  let pushed = false;
  let pushError = null;
  if (args.flags.push) {
    const p = g.tryGit(['push', remote, `refs/heads/${protectedBranch}:refs/heads/${protectedBranch}`], { cwd: root, timeout: 180000 });
    pushed = p.ok;
    if (!p.ok) pushError = p.err.split('\n')[0];
  }

  if (record) {
    cs.refresh(ws, record);
    cs.markLanded(root, record, head);
  }

  if (ctx.json) {
    console.log(JSON.stringify({
      snapshot: snap.id, branch, protectedBranch,
      from: localProtected, to: head, commits: commitCount,
      undoable: !!localProtected, changeset: record ? record.id : null,
      switched, pushed, pushError, landed: true,
    }, null, 2));
    return pushError ? 1 : 0;
  }

  console.log();
  console.log(`  ${ok(`landed ${c.bold(branch)} onto ${c.bold(protectedBranch)} — ${plural(commitCount, 'commit')} fast-forwarded`)}`);
  console.log(`  ${c.grey(`${protectedBranch} ${sym.arrow} ${head.slice(0, 10)}`)}`);
  console.log(`  ${c.grey(switched ? `switched to ${protectedBranch}` : `${branch} is unchanged and still checked out`)}`);
  if (record) console.log(`  ${c.grey(`change set ${record.id} marked landed`)}`);
  if (args.flags.push) {
    console.log(pushed ? `  ${c.grey(`pushed to ${remote}/${protectedBranch}`)}` : `  ${bad(`push failed: ${pushError}`)}`);
  } else {
    console.log(`  ${c.grey('add')} ${c.bold('--push')} ${c.grey(`to publish ${protectedBranch} to ${remote}`)}`);
  }
  if (localProtected) {
    console.log(`  ${c.grey(`undo with:  poly land --self --undo`)}${pushed ? c.grey(`   (${remote}/${protectedBranch} was fast-forwarded too)`) : ''}`);
  }
  console.log();
  return pushError ? 1 : 0;
}

/**
 * poly land --self --undo — move the protected branch back to where the last
 * `land --self` found it (refs/poly/land/<branch>/from).
 *
 * Non-destructive: the un-landed commits stay reachable from the branch you
 * landed from and from the pre-land snapshot, and the anchor refs are left in
 * place. It refuses unless the branch is still exactly where `land --self` left
 * it (otherwise something new landed on top and walking back would drop it), and
 * it never touches the remote — poly will not force-push.
 */
async function undoSelf(args, ctx, ws, { protectedBranch, remote, dryRun }) {
  const root = ws.root;
  const refs = landUndoRefs(protectedBranch);
  const prev = g.resolveRef(root, refs.from);
  const landed = g.resolveRef(root, refs.onto);
  if (!prev || !landed) {
    console.error(`No recorded "land --self" to undo for ${protectedBranch}.`);
    return 2;
  }
  const cur = g.resolveRef(root, `refs/heads/${protectedBranch}`);
  if (!cur) {
    console.error(`${protectedBranch} does not exist locally.`);
    return 2;
  }
  if (cur === prev) {
    if (ctx.json) console.log(JSON.stringify({ protectedBranch, undone: false, reason: 'already at recorded position' }, null, 2));
    else console.log(`\n  ${c.grey(`${protectedBranch} is already back at ${prev.slice(0, 10)} — nothing to undo`)}\n`);
    return 0;
  }
  if (cur !== landed) {
    console.error(
      `${protectedBranch} is at ${cur.slice(0, 10)}, not where "land --self" left it (${landed.slice(0, 10)}) — ` +
      `something has landed since. Walk it back by hand if you are sure.`
    );
    return 1;
  }

  // --undo is only ever a ref move. If the protected branch is checked out
  // anywhere, moving it would leave that worktree's index and files ahead of the
  // branch — so require it to be checked out nowhere. When it is checked out
  // right here, point at the branch that was landed so the two-step is trivial.
  const elsewhere = branchCheckedOutElsewhere(root, protectedBranch);
  if (elsewhere) {
    console.error(`${protectedBranch} is checked out in another worktree:\n  ${elsewhere}`);
    return 2;
  }
  if (g.currentBranch(root) === protectedBranch) {
    const landedFrom = (g.tryGit(
      ['for-each-ref', '--format=%(refname:short)', '--points-at', landed, 'refs/heads/'], { cwd: root }
    ).out || '').split('\n').filter(b => b && b !== protectedBranch)[0];
    console.error(`${protectedBranch} is checked out here — "--undo" only moves the ref.`);
    console.error(landedFrom
      ? `Run:  git checkout ${landedFrom} && poly land --self --undo`
      : `Switch to another branch first, then re-run.`);
    return 2;
  }

  const dropped = Number(g.tryGit(['rev-list', '--count', `${prev}..${cur}`], { cwd: root }).out || 0);

  if (dryRun) {
    if (ctx.json) console.log(JSON.stringify({ dryRun: true, protectedBranch, from: cur, to: prev, unland: dropped }, null, 2));
    else console.log(`\n  ${c.bold(protectedBranch)}  ${c.grey(`${cur.slice(0, 10)} ${sym.arrow} ${prev.slice(0, 10)}`)}  ${c.grey(`(${plural(dropped, 'commit')} un-landed)`)}\n`);
    return 0;
  }

  let snap;
  try {
    snap = safety.guard(ws, `before land --self --undo ${protectedBranch}`);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const upd = g.tryGit(['update-ref', '-m', 'poly land --self --undo', `refs/heads/${protectedBranch}`, prev, cur], { cwd: root });
  if (!upd.ok) {
    if (ctx.json) console.log(JSON.stringify({ snapshot: snap.id, protectedBranch, undone: false, error: upd.err }, null, 2));
    else console.log(`\n  ${bad(`could not move ${protectedBranch}: ${upd.err.split('\n')[0]}`)}\n`);
    return 1;
  }

  const rp = g.resolveRef(root, `refs/remotes/${remote}/${protectedBranch}`);
  const remoteAhead = rp && rp !== prev && g.isAncestor(root, prev, rp);

  if (ctx.json) {
    console.log(JSON.stringify({ snapshot: snap.id, protectedBranch, from: cur, to: prev, unlanded: dropped, remoteAhead: !!remoteAhead, undone: true }, null, 2));
    return 0;
  }
  console.log();
  console.log(`  ${ok(`${protectedBranch} moved back to ${prev.slice(0, 10)} — ${plural(dropped, 'commit')} un-landed`)}`);
  console.log(`  ${c.grey(`the un-landed commits are still on the branch you landed from, and in snapshot ${snap.id}`)}`);
  if (remoteAhead) console.log(`  ${warn(`${remote}/${protectedBranch} is still ahead — poly will not force-push it back`)}`);
  console.log();
  return 0;
}

module.exports = {
  run,
  help: {
    usage: 'poly land [--changeset <id>] [--dry-run] [--no-commit] [--pin] [--message <m>]  |  poly land --self [--switch] [--push] [--undo]',
    summary: 'Bump submodule pointers to what landed; --self fast-forwards the superproject branch',
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
      '',
      'poly land --self  fast-forwards the superproject\'s OWN protected branch to',
      'the branch you are on — the sibling of the pointer bump, for when the bump',
      'commit (or any superproject work) is on a feature branch and ready to land.',
      'It only ever fast-forwards: if main has moved it refuses and points you at',
      '"poly sync --pull". The move is one ref update — no checkout unless --switch,',
      'no merge commit. The pre-move position is saved so --undo can walk it back.',
      '',
      '  --self             land the superproject branch itself, not the pointers',
      '  --undo             move the protected branch back to the last --self position',
      '  --switch           check out the protected branch afterwards',
      '  --push             push the protected branch to its remote (never forced)',
      '  --changeset <id>   refuse unless that change set has fully merged; mark it',
      '                     landed once the branch moves',
      '  --dry-run          show the move, change nothing',
      '  --no-verify        skip the Gate 1 check',
      '  --force            proceed despite a dirty tree or an unmerged change set',
    ].join('\n'),
  },
};
