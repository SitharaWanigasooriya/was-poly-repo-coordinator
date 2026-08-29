'use strict';
/** L1 — argument parsing, dispatch, help. Ergonomics only; correctness lives in src/policy.js. */

const path = require('path');
const { c, sym, ok, bad, warn, info, table, heading, indent } = require('./ui');
const { DestructiveCommandError } = require('./git');

const COMMANDS = {
  status: require('./commands/status'),
  check: require('./commands/check'),
  doctor: require('./commands/doctor'),
  save: require('./commands/save'),
  snapshots: require('./commands/snapshots'),
  restore: require('./commands/restore'),
  sync: require('./commands/sync'),
  run: require('./commands/run'),
  init: require('./commands/init'),
};

// Presentation order for help: the everyday ones first.
const GROUPS = [
  {
    title: 'Every day',
    commands: ['status', 'check', 'doctor'],
  },
  {
    title: 'Your safety net',
    commands: ['save', 'snapshots', 'restore'],
  },
  {
    title: 'Workspace',
    commands: ['sync', 'run', 'init'],
  },
];

const ALIASES = {};
for (const [name, cmd] of Object.entries(COMMANDS)) {
  for (const alias of cmd.aliases || []) ALIASES[alias] = name;
}

/**
 * Minimal parser: --flag, --flag=value, --no-flag, -abc, then positionals.
 * Everything after `--` is positional verbatim, so `poly run` can take flags.
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (passthrough) { positional.push(arg); continue; }
    if (arg === '--') { passthrough = true; continue; }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (body.startsWith('no-')) {
        flags[body] = true;
        flags[body.slice(3)] = false;
      } else {
        // Consume a value for flags that take one.
        const next = argv[i + 1];
        if (['branch', 'label', 'C'].includes(body) && next && !next.startsWith('-')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      if (arg === '-C') {
        flags.C = argv[++i];
        continue;
      }
      for (const ch of arg.slice(1)) flags[ch] = true;
      continue;
    }

    positional.push(arg);
  }

  return { flags, positional };
}

function versionString() {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version;
  } catch {
    return '0.0.0';
  }
}

function printHelp(commandName) {
  if (commandName && COMMANDS[commandName]) {
    const cmd = COMMANDS[commandName];
    console.log();
    console.log(`  ${c.bold(cmd.help.usage)}`);
    console.log();
    console.log(indent(cmd.help.summary, '  '));
    if (cmd.help.detail) {
      console.log();
      console.log(indent(c.grey(cmd.help.detail), '  '));
    }
    if (cmd.aliases && cmd.aliases.length) {
      console.log();
      console.log(indent(c.grey(`aliases: ${cmd.aliases.join(', ')}`), '  '));
    }
    console.log();
    return 0;
  }

  console.log();
  console.log(`  ${c.bold('poly')} ${c.grey('— safe coordination across a superproject and its submodules')}`);
  console.log();
  console.log(indent(c.grey('Your work is never destroyed. Every command that writes anything takes a'), '  '));
  console.log(indent(c.grey('restorable snapshot first, and destructive git commands are refused outright.'), '  '));

  for (const group of GROUPS) {
    console.log(heading(`  ${group.title}`));
    console.log(table(
      [
        { key: 'name', header: '' },
        { key: 'summary', header: '' },
      ],
      group.commands.map(name => ({
        name: c.bold(name),
        summary: c.grey(COMMANDS[name].help.summary),
      })),
      { indent: '    ', gap: 3 }
    ));
  }

  console.log();
  console.log(`  ${c.grey('poly help <command>')}   detail on one command`);
  console.log(`  ${c.grey('-C <dir>')}              run as if from <dir>`);
  console.log(`  ${c.grey('--json')}                machine-readable output`);
  console.log();
  console.log(`  ${c.grey('Getting started:')}  ${c.bold('poly init')}  ${c.grey(sym.arrow)}  ${c.bold('poly status')}  ${c.grey(sym.arrow)}  ${c.bold('poly check')}`);
  console.log();
  return 0;
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.flags.version || args.flags.V) {
    console.log(versionString());
    return 0;
  }

  let name = args.positional.shift();

  if (!name || name === 'help') {
    return printHelp(args.positional[0] && (ALIASES[args.positional[0]] || args.positional[0]));
  }

  name = ALIASES[name] || name;

  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command: ${name}`);
    const near = Object.keys(COMMANDS)
      .concat(Object.keys(ALIASES))
      .filter(k => k.startsWith(name[0]));
    if (near.length) console.error(`Did you mean: ${near.join(', ')}?`);
    console.error('Run "poly help" to see everything.');
    return 2;
  }

  if (args.flags.help || args.flags.h) return printHelp(name);

  const ctx = {
    cwd: args.flags.C ? path.resolve(args.flags.C) : process.cwd(),
    json: !!args.flags.json,
  };

  try {
    return command.run(args, ctx) || 0;
  } catch (err) {
    if (err instanceof DestructiveCommandError) {
      // Should be unreachable: it means the tool tried to destroy something.
      console.error();
      console.error(bad('Stopped before doing something destructive.'));
      console.error(indent(err.message, '  '));
      console.error();
      console.error(indent(c.grey('This is a bug in poly — it should never have tried that. Your work is untouched.'), '  '));
      return 2;
    }
    if (err.userFacing) {
      console.error();
      console.error(indent(err.message, '  '));
      console.error();
      return 2;
    }
    console.error();
    console.error(bad(err.message));
    if (process.env.POLY_DEBUG) console.error(err.stack);
    else console.error(indent(c.grey('set POLY_DEBUG=1 for a stack trace'), '  '));
    console.error();
    return 2;
  }
}

module.exports = { main, parseArgs, COMMANDS, printHelp };
