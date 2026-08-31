'use strict';
/** poly doctor — every check, grouped, with a suggested fix for each. Read-only. */

const m = require('../manifest');
const g = require('../git');
const policy = require('../policy');
const safety = require('../safety');
const { c, sym, ok, bad, warn, info, heading, plural, indent, relTime } = require('../ui');

const INVARIANT_NAMES = {
  I1: 'referential integrity',
  I2: 'durability',
  I3: 'review integrity',
  I4: 'buildability',
  I5: 'independent safety',
  I6: 'manifest coherence',
  I7: 'reproducibility',
  I8: 'auditability',
  E23: 'workspace — detached HEAD',
  E24: 'workspace — uncommitted work',
};

async function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd);
  const result = policy.checkAll(ws, { treeish: 'INDEX' });

  const online = args.flags.online || process.env.POLY_ONLINE === '1';
  if (online) {
    await policy.augmentWithReviews(result, ws);
  }

  const counts = policy.summarise(result.findings);

  if (ctx.json) {
    console.log(JSON.stringify({ root: ws.root, counts, findings: result.findings, notChecked: result.notChecked }, null, 2));
    return counts.errors ? 1 : 0;
  }

  console.log();
  console.log(`  ${c.bold('poly doctor')}  ${c.grey(ws.root)}`);

  if (!ws.hasManifest) {
    console.log();
    console.log(`  ${warn(`no ${m.MANIFEST_NAME}`)}`);
    console.log(indent(c.grey('Nothing is enforced until a manifest exists. Members below were discovered from .gitmodules.'), '      '));
    console.log(indent(`${c.grey('fix:')} poly init`, '      '));
  }

  // Group findings by invariant so related problems read together.
  const byInvariant = new Map();
  for (const f of result.findings) {
    const key = f.invariant || 'other';
    if (!byInvariant.has(key)) byInvariant.set(key, []);
    byInvariant.get(key).push(f);
  }

  const order = ['I1', 'I2', 'I3', 'I6', 'E23', 'E24', 'other'];
  const keys = [...byInvariant.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (const key of keys) {
    const group = byInvariant.get(key);
    const label = INVARIANT_NAMES[key] ? `${key} — ${INVARIANT_NAMES[key]}` : key;
    const worst = group.some(f => f.severity === 'error') ? 'error'
      : group.some(f => f.severity === 'warn') ? 'warn' : 'info';
    const colour = worst === 'error' ? c.red : worst === 'warn' ? c.yellow : c.grey;

    console.log(heading(`  ${colour(label)}  ${c.grey(`(${group.length})`)}`));
    for (const f of group) {
      const mark = f.severity === 'error' ? bad('') : f.severity === 'warn' ? warn('') : info('');
      console.log(`  ${mark}${f.title}`);
      if (f.detail) console.log(indent(c.grey(f.detail), '      '));
      if (f.fix) console.log(indent(`${c.grey('fix:')} ${f.fix}`, '      '));
    }
  }

  if (result.findings.length === 0) {
    console.log();
    console.log(`  ${ok('all checks pass')}`);
  }

  // Safety net status is part of the diagnosis: it is what makes everything else recoverable.
  console.log(heading('  safety net'));
  const snapshots = safety.listSnapshots(ws);
  if (!snapshots.length) {
    console.log(`  ${info('no snapshots yet')}`);
    console.log(indent(c.grey('Snapshots capture committed and uncommitted work, including untracked files,'), '      '));
    console.log(indent(c.grey('as real git objects that survive branch deletion and gc.'), '      '));
    console.log(indent(`${c.grey('fix:')} poly save "before I start"`, '      '));
  } else {
    console.log(`  ${ok(`${plural(snapshots.length, 'snapshot')}, most recent ${relTime(snapshots[0].when)}`)}`);
    console.log(indent(c.grey(`latest: ${snapshots[0].id}${snapshots[0].label ? ` — ${snapshots[0].label}` : ''}`), '      '));
    console.log(indent(c.grey('poly snapshots   list them    poly restore <id>   bring one back'), '      '));
  }

  // row.pinned comes from gate1 (checkAll) above — no extra git calls.
  const pinnable = result.rows.filter(r => r.pinned !== undefined);
  const pinnedCount = pinnable.filter(r => r.pinned).length;
  if (pinnable.length) {
    const line = `${pinnedCount}/${pinnable.length} pointer(s) pinned`;
    if (pinnedCount === pinnable.length) console.log(`  ${ok(line)}`);
    else {
      console.log(`  ${info(line)}`);
      console.log(indent(`${c.grey('fix:')} poly pin`, '      '));
    }
  }

  if (result.notChecked.length) {
    console.log(heading('  not checked'));
    for (const n of result.notChecked) console.log(`  ${info(n)}`);
  }

  console.log();
  const parts = [];
  if (counts.errors) parts.push(c.red(plural(counts.errors, 'problem')));
  if (counts.warnings) parts.push(c.yellow(plural(counts.warnings, 'warning')));
  if (counts.infos) parts.push(c.grey(plural(counts.infos, 'note')));
  console.log(`  ${parts.length ? parts.join(c.grey(', ')) : c.green('clean')}`);
  console.log();

  return counts.errors ? 1 : 0;
}

module.exports = {
  run,
  aliases: ['dr'],
  help: {
    usage: 'poly doctor [--online] [--json]',
    summary: 'Full diagnosis: every invariant, grouped, with fixes',
    detail: [
      'Read-only. Runs Gate 1 plus manifest-coherence and local-workspace checks,',
      'reports pin coverage, and reports the state of your safety net.',
      '',
      '  --online   also check I3 (review integrity) against GitHub',
    ].join('\n'),
  },
};
