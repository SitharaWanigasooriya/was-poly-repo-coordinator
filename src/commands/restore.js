'use strict';
/**
 * poly restore — bring a snapshot back.
 *
 * Default is non-destructive: it creates a branch at the snapshot commit in
 * each repo and leaves your working tree untouched, so you can look before you
 * leap.
 *
 * --apply writes the snapshot's file contents back into the working tree. That
 * always takes a fresh snapshot of the current state first, so --apply is
 * itself undoable, and it never deletes files that exist now.
 */

const m = require('../manifest');
const safety = require('../safety');
const { c, sym, ok, bad, warn, info, table, heading, relTime, plural, indent } = require('../ui');

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd);
  const id = args.positional[0] || 'latest';

  let snapshot;
  try {
    snapshot = safety.findSnapshot(ws, id);
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  if (!snapshot) {
    console.error(`No snapshot matching "${id}".`);
    console.error('  poly snapshots   lists what is available');
    return 2;
  }

  const apply = !!args.flags.apply;

  // --- confirmation for the destructive-to-current-content path ---
  if (apply && !args.flags.yes && process.stdin.isTTY) {
    console.log();
    console.log(`  ${warn('--apply overwrites the current contents of tracked files')}`);
    console.log(indent(c.grey(
      'A snapshot of the current state is taken first, so this is reversible.\n' +
      'Files that exist now but were not in the snapshot are left alone.'), '      '));
    console.log(indent(`${c.grey('re-run with')} ${c.bold('--yes')} ${c.grey('to proceed')}`, '      '));
    console.log();
    return 1;
  }

  let preSnapshot = null;
  if (apply) {
    preSnapshot = safety.snapshotAll(ws, { label: `before restore of ${snapshot.id}` });
    const failed = preSnapshot.repos.filter(r => !r.ok && !r.skipped);
    if (failed.length) {
      console.error('Refusing to apply: could not snapshot the current state first.');
      for (const f of failed) console.error(`  ${f.name}: ${f.error}`);
      return 1;
    }
  }

  const results = safety.restoreSnapshot(ws, snapshot, {
    mode: apply ? 'apply' : 'branch',
    branchName: args.flags.branch,
  });

  if (ctx.json) {
    console.log(JSON.stringify({ snapshot: snapshot.id, mode: apply ? 'apply' : 'branch', preSnapshot: preSnapshot ? preSnapshot.id : null, results }, null, 2));
    return results.every(r => r.ok) ? 0 : 1;
  }

  console.log();
  console.log(`  ${c.bold(apply ? 'restored' : 'snapshot available')}  ${c.bold(snapshot.id)}` +
    (snapshot.label ? c.grey(`  “${snapshot.label}”`) : '') +
    c.grey(`  ${relTime(snapshot.when)}`));

  if (preSnapshot) {
    console.log(`  ${c.grey('previous state saved as')} ${c.bold(preSnapshot.id)} ${c.grey('— undo with')} ${c.bold(`poly restore ${preSnapshot.id} --apply`)}`);
  }

  console.log();
  console.log(table(
    [
      { key: 'name', header: 'REPO' },
      { key: 'result', header: 'RESULT' },
    ],
    results.map(r => ({
      name: c.bold(r.name),
      result: r.ok ? c.green(`${sym.ok} ${r.action}`) : c.red(`${sym.bad} ${r.error}`),
    })),
    { indent: '  ' }
  ));

  const failed = results.filter(r => !r.ok);
  console.log();

  if (!apply) {
    console.log(`  ${c.grey('your working tree is unchanged. To look at what was saved:')}`);
    const example = results.find(r => r.ok && r.branch);
    if (example) {
      console.log(`    ${c.grey('git -C')} ${example.path} ${c.grey('diff')} ${example.branch}`);
      console.log(`    ${c.grey('git -C')} ${example.path} ${c.grey('checkout')} ${example.branch}`);
    }
    console.log(`  ${c.grey('or write the files back with')} ${c.bold(`poly restore ${snapshot.id} --apply`)}`);
  }
  console.log();

  return failed.length ? 1 : 0;
}

module.exports = {
  run,
  aliases: ['undo'],
  help: {
    usage: 'poly restore [<id>|latest] [--apply] [--yes] [--branch <name>]',
    summary: 'Bring back a snapshot — by default without touching your working tree',
    detail: [
      'Default: creates a branch at the snapshot commit in each repo and changes',
      'nothing else. Inspect it, diff it, cherry-pick from it.',
      '',
      '  --apply         write the snapshot files back into the working tree.',
      '                  Snapshots the current state first, so this is undoable.',
      '                  Never deletes files that exist now.',
      '  --yes           skip the confirmation for --apply',
      '  --branch <name> name for the created branch (default poly/snap/<id>)',
      '',
      'With no id, the most recent snapshot is used.',
    ].join('\n'),
  },
};
