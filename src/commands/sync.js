'use strict';
/**
 * poly sync — get the workspace into a safe shape.
 *
 * What it will do:
 *   - snapshot everything first
 *   - fetch (read-only to your work; only updates remote-tracking refs)
 *   - rescue commits sitting on a detached HEAD by giving them a branch
 *   - attach a detached HEAD to its branch when nothing would be lost
 *   - with --pull, fast-forward only
 *
 * What it will never do: discard changes, force anything, or merge in a way
 * that can conflict. If a repo needs a real merge, sync says so and stops.
 */

const m = require('../manifest');
const g = require('../git');
const safety = require('../safety');
const { c, sym, ok, bad, warn, info, table, heading, plural, indent } = require('../ui');

function syncRepo(repo, opts) {
  const out = { name: repo.name, path: repo.absPath, actions: [], problems: [], role: repo.role };
  const cwd = repo.absPath;

  if (g.isEmptyRepo(cwd)) {
    out.actions.push(c.grey('no commits yet — nothing to do'));
    return out;
  }

  if (opts.fetch) {
    const r = g.tryGit(['fetch', '--prune-tags', repo.remote || 'origin'], { cwd, timeout: 180000 });
    if (r.ok) out.actions.push(c.grey(`fetched ${repo.remote || 'origin'}`));
    else out.problems.push(`fetch failed: ${r.err.split('\n')[0]}`);
  }

  // --- detached HEAD handling ---
  if (g.isDetached(cwd)) {
    const head = g.headSha(cwd);
    const containing = g.tryGit(['branch', '--all', '--contains', 'HEAD'], { cwd });
    const onSomeBranch = containing.ok && containing.out.trim().length > 0;

    if (!onSomeBranch) {
      // These commits belong to no branch. Give them one before anything else.
      const rescue = `poly/rescue/${head.slice(0, 8)}`;
      if (!g.refExists(cwd, `refs/heads/${rescue}`)) {
        const r = g.tryGit(['branch', '--no-track', rescue, head], { cwd });
        if (r.ok) {
          out.actions.push(c.green(`rescued detached commits onto branch ${c.bold(rescue)}`));
        } else {
          out.problems.push(`could not create rescue branch: ${r.err.split('\n')[0]}`);
        }
      } else {
        out.actions.push(c.grey(`rescue branch ${rescue} already exists`));
      }
      out.problems.push(
        `HEAD is detached at ${head.slice(0, 8)} and those commits are on no branch. ` +
        `Left as-is deliberately — switch when you are ready.`
      );
    } else {
      // Safe to attach: a non-forced checkout carries uncommitted changes over,
      // and git itself refuses if anything would be overwritten.
      const target = repo.protectedBranch;
      const r = g.tryGit(['checkout', target], { cwd });
      if (r.ok) out.actions.push(c.green(`attached HEAD to ${c.bold(target)}`));
      else out.problems.push(`could not attach to ${target}: ${r.err.split('\n')[0]}`);
    }
  }

  // --- fast-forward only ---
  if (opts.pull && !g.isDetached(cwd)) {
    const branch = g.currentBranch(cwd);
    const upstreamRef = `${repo.remote || 'origin'}/${branch}`;
    if (g.refExists(cwd, `refs/remotes/${upstreamRef}`)) {
      const ab = g.aheadBehind(cwd, upstreamRef);
      if (ab && ab.behind > 0) {
        const r = g.tryGit(['merge', '--ff-only', upstreamRef], { cwd });
        if (r.ok) out.actions.push(c.green(`fast-forwarded ${ab.behind} commit(s) from ${upstreamRef}`));
        else out.problems.push(
          `cannot fast-forward ${branch}: local and ${upstreamRef} have diverged ` +
          `(${ab.ahead} ahead, ${ab.behind} behind). Merge it yourself when you are ready.`
        );
      }
    }
  }

  return out;
}

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd);

  // Nothing happens before the safety net exists.
  let snap;
  try {
    snap = safety.guard(ws, 'before sync');
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const opts = {
    fetch: args.flags.fetch !== false && !args.flags['no-fetch'],
    pull: !!args.flags.pull,
  };

  const targets = [
    { name: ws.name, absPath: ws.root, role: 'superproject', protectedBranch: ws.manifest.defaults.protectedBranch, remote: ws.manifest.defaults.remote },
    ...ws.members.filter(x => x.present).map(x => ({ ...x, role: 'member' })),
  ];

  const results = targets.map(t => syncRepo(t, opts));

  if (ctx.json) {
    console.log(JSON.stringify({ snapshot: snap.id, results }, null, 2));
    return results.some(r => r.problems.length) ? 1 : 0;
  }

  console.log();
  console.log(`  ${c.grey('safety snapshot')} ${c.bold(snap.id)} ${c.grey('taken first')}`);
  console.log();

  for (const r of results) {
    const busy = r.actions.length || r.problems.length;
    if (!busy) continue;
    console.log(`  ${c.bold(r.name)}`);
    for (const a of r.actions) console.log(`    ${a}`);
    for (const p of r.problems) console.log(`    ${warn(p)}`);
  }

  const idle = results.filter(r => !r.actions.length && !r.problems.length).length;
  if (idle) console.log(`  ${c.grey(`${idle} repo(s) already in good shape`)}`);

  const problems = results.reduce((n, r) => n + r.problems.length, 0);
  console.log();
  if (problems) {
    console.log(`  ${warn(`${plural(problems, 'thing')} ${problems === 1 ? 'needs' : 'need'} your decision — nothing was forced`)}`);
  } else {
    console.log(`  ${ok('workspace is in a safe shape')}`);
  }
  if (!opts.pull) {
    console.log(`  ${c.grey('add')} ${c.bold('--pull')} ${c.grey('to fast-forward branches that are behind (never merges, never conflicts)')}`);
  }
  console.log();

  return problems ? 1 : 0;
}

module.exports = {
  run,
  help: {
    usage: 'poly sync [--no-fetch] [--pull]',
    summary: 'Attach detached HEADs, rescue orphaned commits, fetch — losing nothing',
    detail: [
      'Takes a snapshot before it does anything.',
      '',
      'Commits sitting on a detached HEAD that belong to no branch are given a',
      'poly/rescue/<sha> branch before anything else happens. A detached HEAD is',
      'only re-attached when nothing would be lost.',
      '',
      '  --no-fetch   skip the fetch (fetch only updates remote-tracking refs)',
      '  --pull       fast-forward branches that are behind. Never merges, so it',
      '               can never conflict; diverged branches are reported instead.',
    ].join('\n'),
  },
};
