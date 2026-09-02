'use strict';
/**
 * poly pr — open the member + superproject pull requests for a change set.
 *
 * A thin wrapper over src/pr.js: plan locally (no network), then create through
 * the gh CLI or a GH_TOKEN, exactly like `poly check --online` reads review
 * state. It never pushes a branch for you — an unpushed branch is reported with
 * the push command to run.
 */

const m = require('../manifest');
const github = require('../github');
const pr = require('../pr');
const { c, sym, ok, bad, warn, table, plural } = require('../ui');

const RESULT_COLUMNS = [
  { key: 'name', header: 'REPO' },
  { key: 'flow', header: '' },
  { key: 'result', header: '' },
];

function flowCell(t) {
  return c.grey(`${t.branch || '—'} ${sym.arrow} ${t.base}`);
}

function planRows(targets) {
  return targets.map(t => ({
    name: c.bold(t.name),
    flow: flowCell(t),
    result: t.blocker
      ? c.red(`${sym.bad} ${t.blocker}`)
      : c.grey(`${sym.info} would open a PR into ${t.base}`),
  }));
}

async function run(args, ctx) {
  const ws = m.loadWorkspace(ctx.cwd, { requireManifest: true });

  const str = v => (typeof v === 'string' ? v : null);
  let plan;
  try {
    plan = pr.planPullRequests(ws, {
      memberNames: args.positional.slice(), // command name already shifted by cli.main
      base: str(args.flags.base),
      membersOnly: !!args.flags['members-only'],
      changesetId: str(args.flags.changeset),
    });
  } catch (err) {
    if (err.userFacing) { console.error(err.message); return 2; }
    throw err;
  }

  const { targets, changeset } = plan;
  if (!targets.length) {
    console.error('No repositories in scope — nothing to open a PR for.');
    return 2;
  }

  const openable = targets.filter(t => !t.blocker);
  const dryRun = !!args.flags['dry-run'];
  const auth = dryRun ? { mode: 'none' } : github.detectAuth();

  // Dry run, or no way to reach GitHub: show the plan and stop.
  if (dryRun || auth.mode === 'none') {
    if (ctx.json) {
      console.log(JSON.stringify({ dryRun, auth: auth.mode, changeset: changeset && changeset.id, targets }, null, 2));
    } else {
      console.log();
      console.log(table(RESULT_COLUMNS, planRows(targets), { indent: '  ' }));
      console.log();
      if (!dryRun) {
        console.log(`  ${bad(auth.reason || 'no GitHub auth')}`);
      } else if (openable.length) {
        console.log(`  ${c.grey(`${plural(openable.length, 'PR')} would open — re-run without --dry-run`)}`);
      } else {
        console.log(`  ${c.grey('nothing to open')}`);
      }
      console.log();
    }
    return !dryRun ? 1 : 0;
  }

  const body = str(args.flags.body) || (changeset
    ? `Opened by \`poly pr\`.\n\nChange set: ${changeset.id} — ${changeset.title}`
    : null);

  const results = await pr.openPullRequests(ws, targets, {
    title: str(args.flags.title),
    body,
    draft: !!args.flags.draft,
    auth,
  });

  const created = results.filter(r => r.status === 'created');
  const exists = results.filter(r => r.status === 'exists');
  const failed = results.filter(r => r.status === 'error');
  const blocked = results.filter(r => r.status === 'blocked');

  if (ctx.json) {
    console.log(JSON.stringify({ changeset: changeset && changeset.id, results }, null, 2));
    return failed.length ? 1 : 0;
  }

  console.log();
  console.log(table(RESULT_COLUMNS, results.map(r => ({
    name: c.bold(r.name),
    flow: flowCell(r),
    result:
      r.status === 'created' ? c.green(`${sym.ok} created #${r.number}  ${c.grey(r.url)}`) :
      r.status === 'exists' ? c.grey(`${sym.info} exists #${r.number}  ${r.url}`) :
      r.status === 'blocked' ? c.yellow(`${sym.warn} ${r.message}`) :
      c.red(`${sym.bad} ${r.message}`),
  })), { indent: '  ' }));
  console.log();

  const parts = [];
  if (created.length) parts.push(c.green(`${plural(created.length, 'PR')} opened`));
  if (exists.length) parts.push(c.grey(`${exists.length} already open`));
  if (blocked.length) parts.push(c.yellow(`${plural(blocked.length, 'repo')} skipped`));
  if (failed.length) parts.push(c.red(plural(failed.length, 'failure')));
  console.log(`  ${parts.join(c.grey(', ')) || c.grey('nothing to do')}`);
  if (changeset) console.log(`  ${c.grey(`next:  poly changeset track ${changeset.id}`)}`);
  console.log();

  return failed.length ? 1 : 0;
}

module.exports = {
  run,
  aliases: ['pull-request'],
  help: {
    usage: 'poly pr [<member>...] [--changeset <id>] [--base <branch>] [--title <t>] [--body <b>] [--draft] [--members-only] [--dry-run]',
    summary: 'Open the member + superproject pull requests for a change set',
    detail: [
      'For the superproject and every member on a feature branch, open a pull',
      'request from the current branch into its protected branch. Reports any PR',
      'that is already open rather than creating a second one.',
      '',
      'Writes nothing to any local repository. It will not push for you: a branch',
      'that is not on its remote (or is ahead of it) is skipped with the push',
      'command to run.',
      '',
      'Needs the gh CLI (logged in) or GH_TOKEN / GITHUB_TOKEN — the same auth',
      '"poly check --online" uses.',
      '',
      '  <member>...       open PRs for these members only (default: every repo',
      '                    on a feature branch)',
      '  --changeset <id>  scope to that change set\'s members; the generated PR',
      '                    body links back to it',
      '  --base <branch>   target branch for every PR (default: each repo\'s',
      '                    protected branch)',
      '  --title <t>       PR title (default: the branch\'s last commit subject)',
      '  --body <b>        PR body',
      '  --draft           open as draft PRs',
      '  --members-only    skip the superproject',
      '  --dry-run         show the plan, open nothing',
      '',
      'Then:  poly changeset track <id>   →   poly land --changeset <id>',
    ].join('\n'),
  },
};
