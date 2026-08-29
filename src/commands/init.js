'use strict';
/** poly init — write poly.json by reading .gitmodules. Never overwrites blindly. */

const fs = require('fs');
const path = require('path');
const m = require('../manifest');
const g = require('../git');
const { c, ok, warn, info, table, heading } = require('../ui');

function run(args, ctx) {
  const root = m.findRoot(ctx.cwd);
  if (!root) {
    console.error('Not inside a git repository. Run poly init from your superproject.');
    return 2;
  }
  if (!g.isRepo(root)) {
    console.error(`${root} is not a git repository.`);
    return 2;
  }

  const file = m.manifestPath(root);
  const already = fs.existsSync(file);
  const refresh = args.flags.refresh;

  if (already && !refresh && !args.flags.force) {
    console.log(warn(`${m.MANIFEST_NAME} already exists in ${root}`));
    console.log(info('poly init --refresh   merge in submodules added since'));
    console.log(info('poly init --force     overwrite it completely'));
    return 1;
  }

  const discovered = m.discover(root);

  let manifest = discovered;
  if (already && refresh) {
    // Keep every hand-edited field; only add members that are genuinely new.
    const existing = m.read(root);
    const knownPaths = new Set(existing.members.map(x => x.path));
    const added = discovered.members.filter(x => !knownPaths.has(x.path));
    manifest = { ...existing, members: [...existing.members, ...added] };
    manifest._added = added;
  }

  if (ctx.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }

  const added = manifest._added;
  delete manifest._added;
  m.write(root, manifest);

  console.log(ok(`wrote ${m.MANIFEST_NAME}`) + c.grey(`  ${root}`));

  if (refresh && added) {
    if (added.length === 0) console.log(info('no new submodules found'));
    else console.log(ok(`added ${added.length} new member(s): ${added.map(x => x.name).join(', ')}`));
  }

  if (manifest.members.length === 0) {
    console.log();
    console.log(warn('No submodules found in this repository.'));
    console.log(info('poly works on a superproject that has submodules. Add one with:'));
    console.log(info('  git submodule add <url> <path>'));
    console.log(info('then run "poly init --refresh".'));
    return 0;
  }

  console.log(heading(`${manifest.members.length} member(s)`));
  console.log(table(
    [
      { key: 'name', header: 'MEMBER' },
      { key: 'path', header: 'PATH' },
      { key: 'branch', header: 'PROTECTED' },
      { key: 'state', header: '' },
    ],
    manifest.members.map(mem => {
      const abs = path.resolve(root, mem.path);
      const present = g.isRepo(abs);
      return {
        name: c.bold(mem.name),
        path: c.grey(mem.path),
        branch: mem.protectedBranch,
        state: present ? c.green('checked out') : c.yellow('not checked out'),
      };
    })
  ));

  console.log();
  console.log(info('Review poly.json — especially "protectedBranch" and "dependsOn" — then:'));
  console.log(`  ${c.bold('poly status')}   see where everything stands`);
  console.log(`  ${c.bold('poly check')}    run Gate 1 (pointer integrity)`);

  return 0;
}

module.exports = {
  run,
  help: {
    usage: 'poly init [--refresh] [--force]',
    summary: 'Create poly.json by reading .gitmodules',
    detail: [
      'Discovers submodules and writes a manifest so the rest of the tool has',
      'something to enforce policy against. Safe to run: it only writes poly.json.',
      '',
      '  --refresh   keep your edits, merge in submodules added since',
      '  --force     overwrite the existing manifest completely',
    ].join('\n'),
  },
};
