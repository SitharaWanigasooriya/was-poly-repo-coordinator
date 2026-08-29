'use strict';
/**
 * poly check — Gate 1, pointer integrity.
 *
 * This is the command CI runs. It answers one question mechanically:
 * is every submodule pointer in this superproject state permanently part of
 * that member's protected history? No CI-state or review-state trust required.
 *
 * Read-only. Exit 0 = safe to merge, 1 = not safe.
 */

const m = require('../manifest');
const policy = require('../policy');
const { c, sym, ok, bad, warn, info, table, heading, plural, indent } = require('../ui');

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd);
  const treeish = args.flags.head ? 'HEAD' : 'INDEX';
  const result = policy.gate1(ws, { treeish });

  // In Phase 1 the gate reports rather than blocks unless --strict is passed.
  const strict = args.flags.strict || process.env.POLY_STRICT === '1';
  const findings = strict
    ? result.findings
    : result.findings.map(f => f);

  const counts = policy.summarise(findings);

  if (ctx.json) {
    console.log(JSON.stringify({
      gate: 'pointer-integrity',
      treeish,
      strict,
      pass: counts.errors === 0,
      counts,
      rows: result.rows,
      findings,
      notChecked: result.notChecked,
    }, null, 2));
    return counts.errors ? 1 : 0;
  }

  console.log();
  console.log(`  ${c.bold('Gate 1 — pointer integrity')}  ${c.grey(`(${treeish === 'HEAD' ? 'last commit' : 'staged state'})`)}`);
  console.log(`  ${c.grey(ws.root)}`);

  if (result.rows.length === 0) {
    console.log();
    console.log(info('No submodule pointers to check.'));
    return 0;
  }

  console.log();
  console.log(table(
    [
      { key: 'name', header: 'MEMBER' },
      { key: 'pointer', header: 'POINTER' },
      { key: 'against', header: 'AGAINST' },
      { key: 'verdict', header: 'VERDICT' },
    ],
    result.rows.map(r => ({
      name: c.bold(r.name),
      pointer: c.grey(r.pointer ? r.pointer.slice(0, 10) : '—'),
      against: c.grey(r.protectedRef ? r.protectedRef.replace('refs/remotes/', '').replace('refs/heads/', '') : '—'),
      verdict:
        r.status === 'ok' ? c.green(`${sym.ok} reachable`) :
        r.status === 'broken' ? c.red(`${sym.bad} commit missing`) :
        r.status === 'unmerged' ? c.red(`${sym.bad} not merged`) :
        r.status === 'regression' ? c.red(`${sym.bad} moves backwards`) :
        r.status === 'missing' ? c.yellow(`${sym.warn} no gitlink`) :
        c.grey(`? ${r.notes[0] || 'unverified'}`),
    })),
    { indent: '  ' }
  ));

  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warn');

  for (const f of [...errors, ...warnings]) {
    console.log();
    console.log(`  ${f.severity === 'error' ? bad(f.title) : warn(f.title)} ${c.grey(`[${f.invariant}]`)}`);
    console.log(indent(c.grey(f.detail), '      '));
    if (f.fix) console.log(indent(`${c.grey('fix:')} ${f.fix}`, '      '));
  }

  console.log();
  if (counts.errors === 0 && counts.warnings === 0) {
    console.log(`  ${ok('every pointer is merged into its protected branch')}`);
  } else if (counts.errors === 0) {
    console.log(`  ${ok('no blocking problems')} ${c.grey(`(${plural(counts.warnings, 'warning')})`)}`);
  } else {
    console.log(`  ${bad(`${plural(counts.errors, 'problem')} would put a broken pointer on a protected branch`)}`);
    if (!strict) {
      console.log(`  ${c.grey('reporting mode — pass --strict (or POLY_STRICT=1) to fail the build on this')}`);
    }
  }

  if (result.notChecked.length) {
    console.log(`  ${c.grey(`not checked: ${result.notChecked.join('; ')}`)}`);
  }
  console.log();

  // Phase 1 is a reporting gate: only --strict turns findings into a failure.
  return strict && counts.errors ? 1 : 0;
}

module.exports = {
  run,
  help: {
    usage: 'poly check [--head] [--strict] [--json]',
    summary: 'Gate 1: is every submodule pointer safely merged? (CI-friendly)',
    detail: [
      'Pure Git reachability — no trust in CI or review state is required.',
      'Read-only; it never writes to any repository.',
      '',
      '  --head     check the last commit instead of the staged state',
      '  --strict   exit 1 on problems (Phase 3 enforcement). Default reports only.',
      '  --json     machine-readable output for CI',
      '',
      'In CI:  poly check --head --strict',
    ].join('\n'),
  },
};
