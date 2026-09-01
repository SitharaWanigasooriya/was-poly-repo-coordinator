'use strict';
/**
 * poly pin — make the commit a submodule points at permanently reachable.
 *
 * Writes refs/poly/pins/<member>/<shortsha> in each member repo. Because it is
 * a ref, git gc will never collect the commit, even if the branch it came from
 * is reset or deleted. That is what turns "merged into main" into "durable".
 *
 * Local by default. --push publishes the pin refs so a fresh clone has them too.
 */

const m = require('../manifest');
const safety = require('../safety');
const pins = require('../pins');
const { c, sym, ok, bad, warn, info, table, plural } = require('../ui');

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd, { requireManifest: true });

  const named = args.positional.slice(); // command name already shifted off by cli.main
  const treeish = args.flags.head ? 'HEAD' : 'INDEX';
  const push = !!args.flags.push;

  const unknown = named.filter(n => !ws.members.some(mem => mem.name === n));
  if (unknown.length) {
    console.error(`Unknown member(s): ${unknown.join(', ')}`);
    console.error('  poly status   lists every member name');
    return 2;
  }

  // Writing refs is a mutation: snapshot first, like every other writing command.
  let snap;
  try {
    snap = safety.guard(ws, `before pin${named.length ? ` ${named.join(' ')}` : ''}`);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const results = pins.pinAll(ws, { members: named, treeish, push });

  if (ctx.json) {
    console.log(JSON.stringify({ snapshot: snap.id, treeish, push, results }, null, 2));
    return results.some(r => !r.ok && !r.skipped) ? 1 : 0;
  }

  const acted = results.filter(r => r.ok && !r.already);
  const already = results.filter(r => r.already);
  const skipped = results.filter(r => r.skipped);
  const failed = results.filter(r => !r.ok && !r.skipped);

  console.log();
  console.log(`  ${c.grey('safety snapshot')} ${c.bold(snap.id)}`);
  console.log();

  const shown = results.filter(r => !r.skipped);
  if (shown.length) {
    console.log(table(
      [
        { key: 'name', header: 'MEMBER' },
        { key: 'commit', header: 'COMMIT' },
        { key: 'result', header: 'RESULT' },
      ],
      shown.map(r => ({
        name: c.bold(r.name),
        commit: c.grey(r.sha ? r.sha.slice(0, 10) : '—'),
        result: r.ok
          ? (r.already ? c.grey(`${sym.info} already pinned`) : c.green(`${sym.ok} pinned`)) +
            (r.pushed ? c.grey(' · pushed') : (push && r.ok ? c.yellow(' · not pushed') : ''))
          : c.red(`${sym.bad} ${r.error}`),
      })),
      { indent: '  ' }
    ));
  }

  console.log();
  const parts = [];
  if (acted.length) parts.push(c.green(`${plural(acted.length, 'pin')} written`));
  if (already.length) parts.push(c.grey(`${already.length} already pinned`));
  if (skipped.length) parts.push(c.grey(`${skipped.length} skipped`));
  console.log(`  ${parts.join(c.grey(', ')) || c.grey('nothing to pin')}`);

  if (skipped.length) {
    console.log(`  ${c.grey(`skipped: ${skipped.map(r => `${r.name} (${r.error})`).join(', ')}`)}`);
  }
  if (failed.length) {
    console.log();
    for (const f of failed) console.log(`  ${bad(`${f.name}: ${f.error}`)}`);
    return 1;
  }

  if (!push && acted.length) {
    console.log(`  ${c.grey('add')} ${c.bold('--push')} ${c.grey('to publish the pin refs to each member remote')}`);
  }
  console.log();
  return 0;
}

module.exports = {
  run,
  help: {
    usage: 'poly pin [<member>...] [--push] [--head] [--json]',
    summary: 'Pin the commit each submodule points at so gc can never collect it',
    detail: [
      'Writes refs/poly/pins/<member>/<shortsha> in each member repo. A pin keeps',
      'the exact pinned commit reachable forever, independent of the branch it was',
      'merged through — so a later branch reset or history rewrite cannot orphan',
      'the pointer.',
      '',
      'Takes a safety snapshot first. Nothing here ever deletes a pin.',
      '',
      '  <member>...  pin only these members (default: every recorded pointer)',
      '  --push       also push the pin refs to each member remote',
      '  --head       pin what the last commit records, not the staged state',
      '',
      'Turn on enforcement with "requirePins": true in poly.json — then',
      '"poly check" fails when a pointer has no pin.',
    ].join('\n'),
  },
};
