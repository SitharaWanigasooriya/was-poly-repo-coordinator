'use strict';
/**
 * L2 — the policy engine.
 *
 * One implementation of every invariant check, so the CLI and the CI gate can
 * never disagree about what "correct" means. Everything here is read-only.
 *
 * Gate 1 (pointer-integrity, invariants I1/I2/I3) is the important one: it is
 * pure Git reachability, so it needs no trust in CI state or review state.
 */

const path = require('path');
const g = require('./git');
const github = require('./github');

const SEVERITY = { error: 3, warn: 2, info: 1 };

function finding(o) {
  return {
    severity: 'error',
    invariant: null,
    member: null,
    fix: null,
    ...o,
  };
}

/**
 * Resolve the ref that represents "merged into the protected branch" for a
 * member. The remote-tracking ref is preferred: it reflects what actually
 * landed upstream rather than whatever the local branch happens to point at.
 */
function resolveProtectedRef(memberPath, member) {
  const candidates = [
    `refs/remotes/${member.remote}/${member.protectedBranch}`,
    `refs/heads/${member.protectedBranch}`,
  ];
  for (const ref of candidates) {
    const sha = g.resolveRef(memberPath, ref);
    if (sha) {
      return { ref, sha, remote: ref.startsWith('refs/remotes/') };
    }
  }
  return null;
}

/**
 * Gate 1 — pointer integrity.
 *
 * For every submodule pointer recorded in the superproject, answer the only
 * question that matters at merge time: is that commit permanently part of the
 * member repo's protected history?
 *
 * `treeish` selects which superproject state to judge. Defaults to the index
 * (what you are about to commit); pass 'HEAD' to judge the last commit.
 */
function gate1(workspace, { treeish = 'INDEX', includeHeadComparison = true } = {}) {
  const findings = [];
  const rows = [];

  const links = treeish === 'INDEX'
    ? g.gitlinksInIndex(workspace.root)
    : g.gitlinksInTree(workspace.root, treeish);

  const headLinks = includeHeadComparison && !g.isEmptyRepo(workspace.root)
    ? new Map(g.gitlinksInTree(workspace.root, 'HEAD').map(l => [l.path, l.sha]))
    : new Map();

  const linkByPath = new Map(links.map(l => [l.path, l.sha]));
  const policy = workspace.manifest.policy || {};

  for (const member of workspace.members) {
    const pointer = linkByPath.get(member.path) || null;
    const row = {
      name: member.name,
      path: member.path,
      pointer,
      present: member.present,
      status: 'ok',
      notes: [],
      protectedRef: null,
    };

    if (!pointer) {
      row.status = 'missing';
      row.notes.push('no gitlink recorded in the superproject');
      findings.push(finding({
        severity: 'warn',
        invariant: 'I6',
        member: member.name,
        title: `${member.name}: listed in the manifest but has no gitlink`,
        detail: `The manifest declares ${member.path}, but the superproject records no submodule pointer there.`,
        fix: `Remove it from ${'poly.json'}, or add the submodule with "git submodule add".`,
      }));
      rows.push(row);
      continue;
    }

    if (!member.present) {
      row.status = 'unchecked';
      row.notes.push('not checked out locally');
      findings.push(finding({
        severity: 'warn',
        invariant: 'I1',
        member: member.name,
        title: `${member.name}: cannot verify — submodule not checked out`,
        detail: `${member.path} is not on disk, so the pointer ${pointer.slice(0, 10)} cannot be verified locally.`,
        fix: `git submodule update --init -- ${member.path}`,
      }));
      rows.push(row);
      continue;
    }

    // --- Check 1: does the referenced commit exist at all? (I1) ---
    if (!g.commitExists(member.absPath, pointer)) {
      row.status = 'broken';
      row.notes.push('commit not found');
      findings.push(finding({
        severity: 'error',
        invariant: 'I1',
        member: member.name,
        title: `${member.name}: pointer references a commit that does not exist`,
        detail:
          `The superproject points ${member.path} at ${pointer.slice(0, 10)}, ` +
          `but that commit is not in the member repo.\n` +
          `This is the classic squash-merge failure: the PR head SHA was recorded, ` +
          `but a different commit actually landed.`,
        fix: `git -C ${member.path} fetch --all  (then re-check; if still missing, the commit was rewritten or garbage-collected)`,
      }));
      rows.push(row);
      continue;
    }

    // --- Check 2: is it merged into the protected branch? (I1) ---
    const protectedRef = resolveProtectedRef(member.absPath, member);
    row.protectedRef = protectedRef ? protectedRef.ref : null;

    if (!protectedRef) {
      row.status = 'unchecked';
      row.notes.push(`no ${member.remote}/${member.protectedBranch}`);
      findings.push(finding({
        severity: 'warn',
        invariant: 'I1',
        member: member.name,
        title: `${member.name}: cannot verify — protected branch not found`,
        detail:
          `Neither ${member.remote}/${member.protectedBranch} nor a local ${member.protectedBranch} exists in ${member.path}, ` +
          `so reachability cannot be decided.`,
        fix: `git -C ${member.path} fetch ${member.remote}   — or correct "protectedBranch" for this member in poly.json`,
      }));
    } else if (!g.isAncestor(member.absPath, pointer, protectedRef.sha)) {
      row.status = 'unmerged';
      row.notes.push(`not on ${protectedRef.ref.replace('refs/remotes/', '').replace('refs/heads/', '')}`);
      findings.push(finding({
        severity: policy.requireMergedPointers === false ? 'warn' : 'error',
        invariant: 'I1',
        member: member.name,
        title: `${member.name}: pointer is not merged into the protected branch`,
        detail:
          `${member.path} points at ${pointer.slice(0, 10)} (${g.describeCommit(member.absPath, pointer)}), ` +
          `which is not reachable from ${protectedRef.ref}.\n` +
          `If the superproject merges in this state, the pointer can become unreachable the moment ` +
          `the member branch is deleted or rewritten.`,
        fix: `Merge the member PR first, fetch, then bump the pointer to the commit that actually landed.`,
      }));
    } else {
      row.notes.push('merged');
    }

    // --- Check 3: pointer regression (I1) ---
    const previous = headLinks.get(member.path);
    if (previous && previous !== pointer && g.commitExists(member.absPath, previous)) {
      if (g.isAncestor(member.absPath, pointer, previous)) {
        row.status = row.status === 'ok' ? 'regression' : row.status;
        row.notes.push('moves backwards');
        findings.push(finding({
          severity: policy.blockPointerRegression === false ? 'warn' : 'error',
          invariant: 'I1',
          member: member.name,
          title: `${member.name}: pointer moves backwards`,
          detail:
            `${member.path} would go from ${previous.slice(0, 10)} back to ${pointer.slice(0, 10)}, ` +
            `which is an ancestor of the current pointer. This silently un-ships work.`,
          fix: `If this is a deliberate revert, record it as one. Otherwise re-sync the submodule: git -C ${member.path} checkout ${member.protectedBranch} && git -C ${member.path} pull`,
        }));
      } else if (!g.isAncestor(member.absPath, previous, pointer)) {
        row.notes.push('diverged from previous');
        findings.push(finding({
          severity: 'warn',
          invariant: 'I1',
          member: member.name,
          title: `${member.name}: pointer diverges from the previous one`,
          detail:
            `Neither ${previous.slice(0, 10)} nor ${pointer.slice(0, 10)} is an ancestor of the other. ` +
            `The submodule history was rewritten, or the pointer jumped to an unrelated branch.`,
          fix: `Confirm which commit you actually mean to ship.`,
        }));
      }
    }

    // --- Check 4: durable pin (I2) ---
    const pins = g.listRefs(member.absPath, 'refs/poly/pins/**');
    const pinned = pins.some(p => p.sha === pointer);
    row.pinned = pinned;
    if (!pinned && policy.requirePins) {
      findings.push(finding({
        severity: 'error',
        invariant: 'I2',
        member: member.name,
        title: `${member.name}: no durable pin for the referenced commit`,
        detail:
          `Reachability from ${member.protectedBranch} is not durability — the branch can be reset ` +
          `and history can be rewritten. A pin keeps the commit permanently reachable.`,
        fix: `poly pin ${member.name}`,
      }));
    }

    rows.push(row);
  }

  // --- Check 5: member PR merge state (I3) ---
  // Requires a platform provider (GitHub/GitLab API). Phase 5.
  const notChecked = ['I3 review integrity — run: poly check --online'];

  return { findings, rows, notChecked, treeish };
}

/**
 * I6 — manifest coherence. .gitmodules, the index gitlinks and poly.json must
 * agree on paths, URLs and branches.
 */
function checkManifestCoherence(workspace) {
  const findings = [];
  if (!workspace.hasManifest) return findings;

  const modules = g.parseGitmodules(workspace.root);
  const byPath = new Map(modules.map(m => [(m.path || '').replace(/\\/g, '/'), m]));
  const indexLinks = new Set(g.gitlinksInIndex(workspace.root).map(l => l.path));

  for (const member of workspace.members) {
    const mod = byPath.get(member.path);

    if (!mod) {
      findings.push(finding({
        severity: 'error',
        invariant: 'I6',
        member: member.name,
        title: `${member.name}: in poly.json but not in .gitmodules`,
        detail: `The manifest declares ${member.path}, which .gitmodules does not describe.`,
        fix: `Add the submodule properly, or remove the entry from poly.json.`,
      }));
      continue;
    }

    if (mod.url && member.url && mod.url !== member.url) {
      findings.push(finding({
        severity: 'warn',
        invariant: 'I6',
        member: member.name,
        title: `${member.name}: URL disagreement`,
        detail: `.gitmodules says ${mod.url}\npoly.json says   ${member.url}`,
        fix: `Make them match. The canonical URL is the member's identity.`,
      }));
    }

    if (mod.branch && mod.branch !== member.protectedBranch) {
      findings.push(finding({
        severity: 'warn',
        invariant: 'I6',
        member: member.name,
        title: `${member.name}: branch disagreement`,
        detail: `.gitmodules branch = ${mod.branch}, poly.json protectedBranch = ${member.protectedBranch}`,
        fix: `Align them, or set the member's protectedBranch deliberately.`,
      }));
    }
  }

  for (const [p, mod] of byPath) {
    if (!workspace.members.some(m => m.path === p)) {
      findings.push(finding({
        severity: 'warn',
        invariant: 'I6',
        member: mod.name || p,
        title: `${mod.name || p}: in .gitmodules but not in poly.json`,
        detail: `${p} is a submodule the manifest does not know about, so no policy applies to it.`,
        fix: `poly init --refresh   (re-reads .gitmodules and merges new members in)`,
      }));
    }
  }

  for (const p of indexLinks) {
    if (!byPath.has(p)) {
      findings.push(finding({
        severity: 'error',
        invariant: 'I6',
        member: p,
        title: `${p}: gitlink with no .gitmodules entry`,
        detail:
          `The superproject records a submodule pointer at ${p}, but .gitmodules does not describe it. ` +
          `Clones will not know where to fetch it from.`,
        fix: `Add a [submodule] section for ${p} to .gitmodules, or remove the stray gitlink.`,
      }));
    }
  }

  return findings;
}

/**
 * Local workspace hazards — failure taxonomy category E.
 * Low severity, high frequency, and the ones that actually lose work.
 */
function checkWorkspace(workspace) {
  const findings = [];

  const repos = [
    { name: workspace.name, absPath: workspace.root, role: 'superproject', protectedBranch: null },
    ...workspace.members.filter(m => m.present).map(m => ({ ...m, role: 'member' })),
  ];

  for (const repo of repos) {
    if (g.isEmptyRepo(repo.absPath)) continue;

    if (g.isDetached(repo.absPath)) {
      findings.push(finding({
        severity: 'warn',
        invariant: 'E23',
        member: repo.name,
        title: `${repo.name}: detached HEAD`,
        detail:
          `HEAD is at ${g.describeCommit(repo.absPath, g.headSha(repo.absPath))} with no branch. ` +
          `Commits made here belong to no branch and are easy to lose.`,
        fix: `poly sync   — attaches a branch without touching your changes`,
      }));
    }

    const state = g.worktreeState(repo.absPath);
    if (!state.clean) {
      findings.push(finding({
        severity: 'info',
        invariant: 'E24',
        member: repo.name,
        title: `${repo.name}: ${state.total} uncommitted change(s)`,
        detail:
          `${state.staged} staged, ${state.modified} modified, ${state.untracked} untracked` +
          (state.conflicted ? `, ${state.conflicted} conflicted` : ''),
        fix: `poly save "why"   — captures all of it in a restorable snapshot`,
      }));
    }

    if (state.conflicted) {
      findings.push(finding({
        severity: 'warn',
        invariant: 'E24',
        member: repo.name,
        title: `${repo.name}: ${state.conflicted} unresolved conflict(s)`,
        detail: `A merge or rebase is part-way through.`,
        fix: `Resolve the conflicts, or run "poly save" first so the state is recoverable.`,
      }));
    }
  }

  return findings;
}

/**
 * I3 — review integrity. The one check that needs a platform API.
 *
 * Takes a gate1() result and, for every member whose URL is a github.com repo,
 * asks whether the pointed-at commit reached the protected branch through a
 * merged pull request — and whether that PR was approved.
 *
 * Mutates `result` in place (adds `row.review`, appends findings, rewrites
 * `result.notChecked`) and returns it. Never throws: anything it cannot reach
 * is reported as "not checked", exactly as before it ran.
 *
 * `opts.auth` / `opts.transport` are injectable for tests.
 */
async function augmentWithReviews(result, workspace, opts = {}) {
  const auth = opts.auth || github.detectAuth();
  const policy = workspace.manifest.policy || {};
  const byPath = new Map(workspace.members.map(m => [m.path, m]));

  const notGithub = [];
  let checkedAny = false;
  let authFailed = false;

  for (const row of result.rows) {
    if (!row.pointer || row.status === 'missing' || row.status === 'broken') continue;
    const member = byPath.get(row.path);
    if (!member) continue;

    const gh = github.parseGithubRepo(member.url);
    if (!gh) {
      notGithub.push(member.name);
      continue;
    }

    if (auth.mode === 'none') { authFailed = true; continue; }

    const state = await github.commitReviewState(
      { owner: gh.owner, repo: gh.repo, sha: row.pointer, baseRef: member.protectedBranch },
      auth,
      opts.transport
    );

    row.review = state;
    if (!state.checked) { authFailed = true; continue; }
    checkedAny = true;

    if (!state.merged) {
      row.notes.push('no merged PR');
      result.findings.push(finding({
        severity: policy.requireReviewedPointers === false ? 'warn' : 'error',
        invariant: 'I3',
        member: member.name,
        title: `${member.name}: pointer did not reach ${member.protectedBranch} through a merged PR`,
        detail:
          `${member.path} points at ${row.pointer.slice(0, 10)}. GitHub has no merged pull ` +
          `request into ${member.protectedBranch} that contains it` +
          (state.hasOpenPr ? ' — there is an open PR, but it has not merged yet.' : '.') +
          `\nEither it was pushed straight to the branch, or the PR that carried it targeted a different base.`,
        fix: `Land the change through a reviewed PR into ${member.protectedBranch}, then re-bump the pointer.`,
      }));
    } else if (state.reviewDecision === 'changes_requested') {
      row.notes.push(`PR #${state.prNumber}: changes requested`);
      result.findings.push(finding({
        severity: 'warn',
        invariant: 'I3',
        member: member.name,
        title: `${member.name}: merged PR #${state.prNumber} had changes requested and no later approval`,
        detail: `The commit is on ${member.protectedBranch}, but the review it merged with was not resolved to an approval.`,
        fix: `Confirm the review concern was addressed; nothing to change in the pointer itself.`,
      }));
    } else if (state.reviewDecision === 'no_review') {
      row.notes.push(`PR #${state.prNumber}: no review`);
      result.findings.push(finding({
        severity: 'warn',
        invariant: 'I3',
        member: member.name,
        title: `${member.name}: merged PR #${state.prNumber} had no approving review`,
        detail: `The commit reached ${member.protectedBranch} via a PR, but nobody approved it.`,
        fix: `Decide whether an unreviewed merge is acceptable for this member; consider a branch protection rule.`,
      }));
    } else {
      row.notes.push(`PR #${state.prNumber} approved`);
    }
  }

  result.findings.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);

  // Rewrite the "not checked" line now that we have actually tried.
  result.notChecked = result.notChecked.filter(n => !n.startsWith('I3 '));
  if (!checkedAny && authFailed) {
    result.notChecked.push(`I3 review integrity — ${auth.reason || 'GitHub was unreachable'}`);
  } else if (authFailed) {
    result.notChecked.push('I3 review integrity — some members could not be reached on GitHub');
  }
  if (notGithub.length) {
    result.notChecked.push(`I3 review integrity — not a github.com repo: ${notGithub.join(', ')}`);
  }

  return result;
}

/** Everything, in one pass. */
function checkAll(workspace, opts = {}) {
  const gate = gate1(workspace, opts);
  const findings = [
    ...gate.findings,
    ...checkManifestCoherence(workspace),
    ...checkWorkspace(workspace),
  ];
  findings.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
  return { ...gate, findings };
}

function summarise(findings) {
  return {
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warn').length,
    infos: findings.filter(f => f.severity === 'info').length,
  };
}

module.exports = { gate1, augmentWithReviews, checkManifestCoherence, checkWorkspace, checkAll, summarise, resolveProtectedRef, SEVERITY };
