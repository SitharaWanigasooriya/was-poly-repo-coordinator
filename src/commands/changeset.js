'use strict';
/**
 * poly changeset — track one logical change across several member repos.
 *
 *   poly changeset new "<title>" [member...]   open one
 *   poly changeset list                        every change set, newest first
 *   poly changeset show <id>                    per-member branch / pointer / merged
 *   poly changeset track [<id>]                 recompute merge state from the repos
 *
 * A change set is local working state under .poly/ — nothing is committed and no
 * repository is touched. `poly land --changeset <id>` uses it to scope a bump.
 */

const m = require('../manifest');
const cs = require('../changeset');
const { c, sym, ok, bad, warn, info, table, heading, relTime, plural } = require('../ui');

function asList(v) {
  if (v === undefined || v === true || v === false) return [];
  return [].concat(v);
}

function cmdNew(ws, args, ctx) {
  const [, ...rest] = args.positional; // positional[0] === 'new'
  const memberFlags = asList(args.flags.member);
  // `poly changeset new "title" m1 m2` — first positional is the title, the
  // rest are member names. --member repeats work too.
  const title = args.flags.title || rest[0] || null;
  const memberNames = [...memberFlags, ...rest.slice(1)];

  const record = cs.create(ws, { title, memberNames });

  if (ctx.json) {
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }

  console.log();
  console.log(`  ${ok(`change set ${c.bold(record.id)}`)}  ${c.grey(`“${record.title}”`)}`);
  if (!record.members.length) {
    console.log();
    console.log(`  ${warn('no members selected')}`);
    console.log(`  ${c.grey('name them explicitly:')} ${c.bold('poly changeset new "title" <member> <member>')}`);
    console.log();
    return 0;
  }
  console.log();
  console.log(table(
    [
      { key: 'name', header: 'MEMBER' },
      { key: 'branch', header: 'BRANCH' },
      { key: 'pointer', header: 'POINTER' },
    ],
    record.members.map(e => ({
      name: c.bold(e.name),
      branch: e.branch ? e.branch : c.grey('—'),
      pointer: c.grey(e.pointerAtCreate ? e.pointerAtCreate.slice(0, 10) : '—'),
    })),
    { indent: '  ' }
  ));
  console.log();
  console.log(`  ${c.grey('watch it land:')} ${c.bold(`poly changeset track ${record.id}`)}`);
  console.log(`  ${c.grey('then bump it:')}  ${c.bold(`poly land --changeset ${record.id}`)}`);
  console.log();
  return 0;
}

function cmdList(ws, args, ctx) {
  const all = cs.list(ws.root);
  if (ctx.json) {
    console.log(JSON.stringify(all, null, 2));
    return 0;
  }
  if (!all.length) {
    console.log();
    console.log(info('No change sets yet.'));
    console.log(`  ${c.grey('open one with')} ${c.bold('poly changeset new "what this change is"')}`);
    console.log();
    return 0;
  }
  console.log();
  console.log(table(
    [
      { key: 'id', header: 'ID' },
      { key: 'when', header: 'WHEN', align: 'right' },
      { key: 'status', header: 'STATUS' },
      { key: 'members', header: 'MEMBERS', align: 'right' },
      { key: 'title', header: 'TITLE' },
    ],
    all.map(x => ({
      id: c.bold(x.id),
      when: c.grey(relTime(x.created)),
      status: statusLabel(x.status),
      members: c.grey(String(x.members.length)),
      title: x.title,
    })),
    { indent: '  ' }
  ));
  console.log();
  return 0;
}

function cmdShow(ws, args, ctx) {
  const [, id] = args.positional;
  const target = id ? cs.read(ws.root, id) : cs.list(ws.root)[0];
  if (!target) {
    console.error(id ? `No change set matching "${id}".` : 'No change sets yet.');
    return 2;
  }
  if (ctx.json) {
    console.log(JSON.stringify(target, null, 2));
    return 0;
  }
  console.log();
  console.log(`  ${c.bold(target.id)}  ${c.grey(`“${target.title}”`)}  ${statusLabel(target.status)}  ${c.grey(relTime(target.created))}`);
  console.log();
  console.log(table(
    [
      { key: 'name', header: 'MEMBER' },
      { key: 'branch', header: 'BRANCH' },
      { key: 'pointer', header: 'OPENED AT' },
      { key: 'merged', header: 'MERGED' },
    ],
    target.members.map(e => ({
      name: c.bold(e.name),
      branch: e.branch ? e.branch : c.grey('—'),
      pointer: c.grey(e.pointerAtCreate ? e.pointerAtCreate.slice(0, 10) : '—'),
      merged: e.merged ? c.green(`${sym.ok} yes`) : c.yellow(`${sym.warn} not yet`),
    })),
    { indent: '  ' }
  ));
  console.log();
  const pending = target.members.filter(e => !e.merged).map(e => e.name);
  if (pending.length) {
    console.log(`  ${c.grey(`waiting on: ${pending.join(', ')}`)}`);
    console.log(`  ${c.grey('refresh with')} ${c.bold(`poly changeset track ${target.id}`)}`);
  } else if (target.status !== 'landed') {
    console.log(`  ${ok('every member is merged — ready to land')}`);
    console.log(`  ${c.bold(`poly land --changeset ${target.id}`)}`);
  }
  console.log();
  return 0;
}

function cmdTrack(ws, args, ctx) {
  const [, id] = args.positional;
  const target = id ? cs.read(ws.root, id) : cs.list(ws.root)[0];
  if (!target) {
    console.error(id ? `No change set matching "${id}".` : 'No change sets yet.');
    return 2;
  }
  const { cs: updated, changes } = cs.refresh(ws, target);
  if (ctx.json) {
    console.log(JSON.stringify({ changeset: updated, changes }, null, 2));
    return 0;
  }
  console.log();
  console.log(`  ${c.bold(updated.id)}  ${c.grey(`“${updated.title}”`)}  ${statusLabel(updated.status)}`);
  if (changes.length) {
    for (const ch of changes) {
      console.log(`  ${ok(`${ch.name}: now merged into its protected branch`)}`);
    }
  } else {
    console.log(`  ${c.grey('no change since last check')}`);
  }
  const pending = updated.members.filter(e => !e.merged).map(e => e.name);
  console.log();
  if (pending.length) {
    console.log(`  ${c.grey(`still waiting on ${plural(pending.length, 'member')}: ${pending.join(', ')}`)}`);
  } else {
    console.log(`  ${ok('all members merged — ' + c.bold(`poly land --changeset ${updated.id}`))}`);
  }
  console.log();
  return 0;
}

function statusLabel(s) {
  switch (s) {
    case 'landed': return c.green('landed');
    case 'ready': return c.cyan('ready');
    default: return c.yellow('open');
  }
}

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd, { requireManifest: true });
  const sub = args.positional[0];

  switch (sub) {
    case 'new': case 'open': return cmdNew(ws, args, ctx);
    case 'list': case 'ls': case undefined: return cmdList(ws, args, ctx);
    case 'show': return cmdShow(ws, args, ctx);
    case 'track': case 'refresh': return cmdTrack(ws, args, ctx);
    default:
      console.error(`Unknown subcommand: changeset ${sub}`);
      console.error('  poly changeset new | list | show | track');
      return 2;
  }
}

module.exports = {
  run,
  aliases: ['cs'],
  help: {
    usage: 'poly changeset new "<title>" [member...] | list | show <id> | track [<id>]',
    summary: 'Track one logical change across several member repos',
    detail: [
      'A change set records which members carry a change, on which branch, and',
      'what pointer each started at — so you can watch the pieces land and know',
      'when the whole thing is safe to bump.',
      '',
      'Local only: stored under .poly/, nothing is committed, no repo is touched.',
      '',
      '  new "<title>" [member...]   open one. With no members named, every member',
      '                             on a feature branch or with a dirty tree is included.',
      '  list                       every change set, newest first',
      '  show [<id>]                per-member state (default: the newest)',
      '  track [<id>]               recompute merge state from the repos',
      '',
      'Then:  poly land --changeset <id>',
    ].join('\n'),
  },
};
