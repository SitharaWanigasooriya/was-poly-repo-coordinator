'use strict';
/**
 * poly run <command...> — run the same command in every repo.
 *
 * Snapshots first by default, because the command is arbitrary and this tool's
 * promise is that nothing you do through it can cost you work.
 */

const { spawnSync } = require('child_process');
const m = require('../manifest');
const safety = require('../safety');
const { c, sym, ok, bad, warn, info, heading, plural } = require('../ui');

function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd);
  const command = args.positional;

  if (!command.length) {
    console.error('Nothing to run.  Example:  poly run git status -s');
    return 2;
  }

  const skipSave = args.flags['no-save'];
  let snap = null;
  if (!skipSave) {
    try {
      snap = safety.guard(ws, `before: ${command.join(' ')}`);
    } catch (err) {
      console.error(err.message);
      return 1;
    }
  }

  const targets = [
    ...(args.flags['members-only'] ? [] : [{ name: ws.name, path: ws.root, role: 'superproject' }]),
    ...ws.members.filter(x => x.present).map(x => ({ name: x.name, path: x.absPath, role: 'member' })),
  ];

  if (snap) console.log(`${c.grey('safety snapshot')} ${c.bold(snap.id)}\n`);

  // Windows needs a shell to resolve .cmd/.bat shims such as npm. Node warns
  // when an args array is combined with shell:true, so build one string there
  // and pass the args array everywhere else.
  const needsShell = process.platform === 'win32';
  const quote = a => (/[\s"^&|<>()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const commandLine = command.map(quote).join(' ');

  const results = [];
  for (const t of targets) {
    console.log(`${c.bold(t.name)} ${c.grey(t.path)}`);
    const res = needsShell
      ? spawnSync(commandLine, { cwd: t.path, stdio: 'inherit', shell: true, windowsHide: true })
      : spawnSync(command[0], command.slice(1), { cwd: t.path, stdio: 'inherit', windowsHide: true });
    const code = res.status === null ? 1 : res.status;
    results.push({ name: t.name, path: t.path, code });
    if (code !== 0) {
      console.log(c.red(`  ${sym.bad} exit ${code}`));
      if (!args.flags['keep-going']) {
        console.log(c.grey('  stopping — pass --keep-going to continue through failures'));
        break;
      }
    }
    console.log();
  }

  const failed = results.filter(r => r.code !== 0);
  if (failed.length) {
    console.log(bad(`${plural(failed.length, 'repo')} failed: ${failed.map(f => f.name).join(', ')}`));
    if (snap) console.log(c.grey(`your work before this run is in snapshot ${snap.id}`));
  } else {
    console.log(ok(`ran in ${plural(results.length, 'repo')}`));
  }

  return failed.length ? 1 : 0;
}

module.exports = {
  run,
  aliases: ['foreach', 'each'],
  help: {
    usage: 'poly run [--members-only] [--keep-going] [--no-save] <command...>',
    summary: 'Run one command in every repo',
    detail: [
      'Snapshots everything first, so an unexpected command cannot cost you work.',
      '',
      "Everything after the program's name is passed to it untouched, so its own",
      "flags stay its own. poly's flags therefore go before that name.",
      '',
      '  --members-only  skip the superproject',
      '  --keep-going    continue after a repo fails (default: stop)',
      '  --no-save       skip the snapshot (not recommended)',
      '',
      'Examples:',
      '  poly run git status -s',
      '  poly run git checkout -b 1.x.x',
      '  poly run --keep-going npm test',
    ].join('\n'),
  },
};
