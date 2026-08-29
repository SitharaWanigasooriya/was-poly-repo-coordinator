'use strict';
/** poly snapshots — list every snapshot, read straight from git refs. */

const m = require('../manifest');
const g = require('../git');
const safety = require('../safety');
const { c, ok, info, table, heading, relTime, plural } = require('../ui');

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd);
  const snapshots = safety.listSnapshots(ws);

  if (ctx.json) {
    console.log(JSON.stringify(snapshots, null, 2));
    return 0;
  }

  if (!snapshots.length) {
    console.log();
    console.log(info('No snapshots yet.'));
    console.log(`  ${c.grey('take one with')} ${c.bold('poly save "why"')}`);
    console.log();
    return 0;
  }

  const limit = args.flags.all ? snapshots.length : Math.min(snapshots.length, 20);

  console.log();
  console.log(table(
    [
      { key: 'id', header: 'ID' },
      { key: 'when', header: 'WHEN', align: 'right' },
      { key: 'repos', header: 'REPOS', align: 'right' },
      { key: 'label', header: 'LABEL' },
    ],
    snapshots.slice(0, limit).map(s => ({
      id: c.bold(s.id),
      when: c.grey(relTime(s.when)),
      repos: c.grey(String(s.repos.length)),
      label: s.label ? s.label : c.grey('—'),
    })),
    { indent: '  ' }
  ));

  if (limit < snapshots.length) {
    console.log(`  ${c.grey(`…and ${snapshots.length - limit} older — poly snapshots --all`)}`);
  }

  console.log();
  console.log(`  ${c.grey('inspect:')} ${c.bold('poly restore <id>')} ${c.grey('creates a branch at the snapshot, changing nothing else')}`);
  console.log(`  ${c.grey('recover:')} ${c.bold('poly restore <id> --apply')} ${c.grey('writes the files back (snapshots first)')}`);
  console.log();

  return 0;
}

module.exports = {
  run,
  aliases: ['list', 'ls'],
  help: {
    usage: 'poly snapshots [--all] [--json]',
    summary: 'List saved snapshots',
    detail: [
      'Reads refs/poly/safety/* from every repo, so snapshots stay discoverable',
      'even if .poly/ is deleted. Nothing here ever deletes a snapshot.',
    ].join('\n'),
  },
};
