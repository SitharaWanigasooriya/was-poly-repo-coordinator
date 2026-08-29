'use strict';
/**
 * poly save — capture everything, everywhere, right now.
 *
 * Records committed AND uncommitted work (including untracked files) across
 * the superproject and every member, as real git commit objects held by refs.
 * Your working tree is not touched: unlike `git stash`, nothing is removed.
 */

const m = require('../manifest');
const safety = require('../safety');
const { c, sym, ok, warn, info, table, heading, plural } = require('../ui');

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd);
  const label = args.positional.join(' ').trim() || null;

  const record = safety.snapshotAll(ws, {
    label,
    includeIgnored: args.flags['all-files'] || false,
  });

  if (ctx.json) {
    console.log(JSON.stringify(record, null, 2));
    return record.allOk ? 0 : 1;
  }

  const saved = record.repos.filter(r => r.ok);
  const failed = record.repos.filter(r => !r.ok && !r.skipped);
  const skipped = record.repos.filter(r => r.skipped);
  const withChanges = saved.filter(r => r.changes > 0);

  console.log();
  console.log(`  ${ok(`snapshot ${c.bold(record.id)}`)}${label ? c.grey(`  “${label}”`) : ''}`);

  if (withChanges.length) {
    console.log();
    console.log(table(
      [
        { key: 'name', header: 'REPO' },
        { key: 'branch', header: 'BRANCH' },
        { key: 'changes', header: 'CAPTURED' },
      ],
      withChanges.map(r => ({
        name: c.bold(r.name),
        branch: r.detached ? c.red('(detached)') : (r.branch || c.grey('(none)')),
        changes: c.yellow(
          `${plural(r.changes, 'change')}` +
          (r.untracked ? c.grey(` — includes ${r.untracked} untracked`) : '')
        ),
      })),
      { indent: '  ' }
    ));
  }

  console.log();
  console.log(`  ${c.grey(`${saved.length} repo(s) captured` + (withChanges.length ? `, ${withChanges.length} had uncommitted work` : ', all clean'))}`);

  if (skipped.length) {
    console.log(`  ${info(`${skipped.length} skipped (not checked out): ${skipped.map(r => r.name).join(', ')}`)}`);
  }

  if (failed.length) {
    console.log();
    for (const f of failed) console.log(`  ${c.red(sym.bad)} ${f.name}: ${f.error}`);
    console.log(`  ${c.red('snapshot incomplete — do not rely on it')}`);
    return 1;
  }

  console.log(`  ${c.grey('bring it back with')} ${c.bold(`poly restore ${record.id}`)}`);
  console.log();

  return 0;
}

module.exports = {
  run,
  aliases: ['snap'],
  help: {
    usage: 'poly save [label...] [--all-files]',
    summary: 'Snapshot all work — committed, uncommitted and untracked — so it cannot be lost',
    detail: [
      'Writes a real commit object per repo into refs/poly/safety/<id>. Because it',
      'is a ref, git gc will never collect it and deleting a branch cannot orphan it.',
      '',
      'Your working tree is left exactly as it is. Nothing is stashed or removed.',
      '',
      '  --all-files   also capture .gitignore\'d files (off by default; sweeps up',
      '                node_modules and build output)',
      '',
      'Example:  poly save "before the big refactor"',
    ].join('\n'),
  },
};
