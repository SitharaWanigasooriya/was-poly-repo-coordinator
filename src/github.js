'use strict';
/**
 * GitHub provider — the platform half of invariant I3 (review integrity).
 *
 * Gate 1 answers "is this commit permanently in the member's history" with pure
 * git and no trust in anything. I3 is the question git cannot answer on its own:
 * did this commit reach the protected branch through a reviewed, merged pull
 * request, or did someone push straight to it?
 *
 * This talks to GitHub two ways, in order of preference:
 *   1. the `gh` CLI, if it is installed and logged in — no token handling here.
 *   2. the REST API with a token from GH_TOKEN / GITHUB_TOKEN / `gh auth token`.
 * If neither is available the check reports "not checked" rather than guessing.
 *
 * No npm dependency: `gh` is shelled out to, REST uses Node 18's global fetch.
 * The transport is injectable so tests never touch the network.
 */

const { spawnSync } = require('child_process');

const API_ROOT = 'https://api.github.com';

/** Parse a remote URL into { owner, repo }, or null when it is not github.com. */
function parseGithubRepo(url) {
  if (!url) return null;
  const s = String(url).trim().replace(/\.git$/, '');
  // git@github.com:owner/repo  or  ssh://git@github.com/owner/repo
  let m = s.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  // https://github.com/owner/repo   (also http, also with a trailing slash)
  m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

function ghAvailable() {
  try {
    const r = spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function ghToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* gh not installed */ }
  return null;
}

/**
 * Decide how to reach GitHub.
 * Returns { mode: 'gh' | 'token' | 'none', token?, reason? }.
 */
function detectAuth() {
  if (ghAvailable()) return { mode: 'gh' };
  const token = ghToken();
  if (token) return { mode: 'token', token };
  return {
    mode: 'none',
    reason: 'no GitHub auth — install the gh CLI and run `gh auth login`, or set GH_TOKEN',
  };
}

/**
 * One GET against the GitHub API. Returns { ok, status, body } and never throws.
 * `transport` is for tests: (path, auth) => { ok, status, body }.
 */
async function apiGet(path, auth, transport) {
  if (transport) return transport(path, auth);

  if (auth.mode === 'gh') {
    const r = spawnSync('gh', ['api', path], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) {
      return { ok: false, status: 0, body: null, error: (r.stderr || 'gh api failed').trim().split('\n')[0] };
    }
    try {
      return { ok: true, status: 200, body: JSON.parse(r.stdout) };
    } catch (err) {
      return { ok: false, status: 0, body: null, error: `could not parse gh output: ${err.message}` };
    }
  }

  if (auth.mode === 'token') {
    try {
      const res = await fetch(API_ROOT + path, {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'poly',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
      return { ok: res.ok, status: res.status, body, error: res.ok ? null : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, body: null, error: err.message };
    }
  }

  return { ok: false, status: 0, body: null, error: 'no auth' };
}

/**
 * The review/merge state of one commit.
 *
 * Returns:
 *   { checked: false, reason }                          — could not find out
 *   { checked: true, merged: false }                    — no merged PR contains it
 *   { checked: true, merged: true, prNumber, baseRef,
 *     reviewDecision: 'approved' | 'changes_requested' | 'no_review' }
 */
async function commitReviewState({ owner, repo, sha, baseRef }, auth, transport) {
  const pulls = await apiGet(`/repos/${owner}/${repo}/commits/${sha}/pulls`, auth, transport);
  if (!pulls.ok) return { checked: false, reason: pulls.error || `HTTP ${pulls.status}` };

  const list = Array.isArray(pulls.body) ? pulls.body : [];
  const merged = list.filter(pr => pr.merged_at && (!baseRef || (pr.base && pr.base.ref === baseRef)));

  if (!merged.length) {
    // The commit exists but no merged PR on the right base contains it.
    const openOnBase = list.some(pr => !pr.merged_at && (!baseRef || (pr.base && pr.base.ref === baseRef)));
    return { checked: true, merged: false, hasOpenPr: openOnBase };
  }

  // Prefer the most recently merged matching PR.
  merged.sort((a, b) => new Date(b.merged_at) - new Date(a.merged_at));
  const pr = merged[0];

  const reviews = await apiGet(`/repos/${owner}/${repo}/pulls/${pr.number}/reviews`, auth, transport);
  let reviewDecision = 'no_review';
  if (reviews.ok && Array.isArray(reviews.body)) {
    // Last submitted review per reviewer wins.
    const latest = new Map();
    for (const rv of reviews.body) {
      if (!rv.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(rv.state)) continue;
      latest.set(rv.user.login, rv.state);
    }
    const states = [...latest.values()];
    if (states.includes('CHANGES_REQUESTED')) reviewDecision = 'changes_requested';
    else if (states.includes('APPROVED')) reviewDecision = 'approved';
  }

  return {
    checked: true,
    merged: true,
    prNumber: pr.number,
    baseRef: pr.base && pr.base.ref,
    reviewDecision,
  };
}

module.exports = {
  API_ROOT,
  parseGithubRepo,
  detectAuth,
  apiGet,
  commitReviewState,
  // exported for tests
  _internal: { ghAvailable, ghToken },
};
