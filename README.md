# poly — WAS Poly-Repo Coordination Tool

[![CI](https://github.com/wanigasooriya-solutions/was-poly-repo-coordinator/actions/workflows/ci.yml/badge.svg)](https://github.com/wanigasooriya-solutions/was-poly-repo-coordinator/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@wanigasooriya-solutions/poly)](https://www.npmjs.com/package/@wanigasooriya-solutions/poly)

Safe coordination of change sets across a Git superproject and its submodules.

```sh
pnpm add -g @wanigasooriya-solutions/poly
```

Implements **Phase 1 (Visibility)** of the [Solution Definition](docs/solution.docx),
plus the safety layer that everything later depends on.

## Documents

| Document | What it covers |
|---|---|
| [Problem Definition](docs/problem.docx) | Invariants I1–I8, the 33-item failure taxonomy, scope and non-goals |
| [Solution Definition](docs/solution.docx) | ChangeSet primitive, the two gates, the saga, staging plan |
| [ADR-0001 — Implementation Language](docs/adr-0001-implementation-language.docx) | Why Node.js, the costs accepted, and the triggers to revisit before Phase 5 |

---

## The promise

**Nothing you do through this tool can cost you work.** That is enforced two ways,
not merely intended:

1. **Destructive git commands are refused outright.** Every git call goes through
   one wrapper that blocks `reset --hard`, `clean`, `checkout -f`, `push --force`,
   `branch -D`, `stash drop`, `gc`, `rebase`, `commit --amend` and more. If any
   code path ever tries one, it throws instead of running.

2. **Every command that writes takes a snapshot first.** A snapshot captures
   committed *and* uncommitted work — including untracked files — across every
   repo, as real git commit objects held by `refs/poly/safety/<id>`. Because they
   are refs, `git gc` cannot collect them and deleting a branch cannot orphan them.

Snapshots are built through a temporary index, so **your working tree is never
touched**. Unlike `git stash`, nothing is removed from under you.

Nothing in this tool ever deletes a snapshot.

## Install

```sh
pnpm add -g @wanigasooriya-solutions/poly
poly help
```

<details>
<summary>npm / yarn / one-off</summary>

```sh
npm  install -g @wanigasooriya-solutions/poly
yarn global add @wanigasooriya-solutions/poly

# or run it without installing
pnpm dlx @wanigasooriya-solutions/poly status
npx @wanigasooriya-solutions/poly status
```
</details>

Node 18+. No build step, no runtime dependencies.

### From a clone

```sh
pnpm install
pnpm link --global     # gives you a global `poly` pointing at your working copy
pnpm test
```

## Getting started

```sh
cd your-superproject
poly init         # reads .gitmodules, writes poly.json
poly status       # where everything stands
poly check        # Gate 1: is every submodule pointer safely merged?
```

## Commands

### Every day

| Command | What it does |
|---|---|
| `poly status` | Branch, uncommitted work and pointer health for every repo. Read-only. |
| `poly check` | **Gate 1** — is every submodule pointer merged into its protected branch? Read-only, CI-friendly. |
| `poly doctor` | Full diagnosis grouped by invariant, each with a suggested fix. Read-only. |

### Your safety net

| Command | What it does |
|---|---|
| `poly save "why"` | Snapshot all work everywhere. Working tree untouched. |
| `poly snapshots` | List snapshots (read straight from git refs). |
| `poly restore <id>` | Create a branch at the snapshot. Changes nothing else. |
| `poly restore <id> --apply` | Write the files back. Snapshots current state first, so it is undoable. Never deletes files. |

### Workspace

| Command | What it does |
|---|---|
| `poly sync` | Rescue orphaned commits, attach detached HEADs, fetch. Forces nothing. |
| `poly run <cmd>` | Run one command in every repo (snapshots first). |
| `poly init` | Write `poly.json` from `.gitmodules`. |

Aliases: `st`/`s` → status, `dr` → doctor, `snap` → save, `ls`/`list` → snapshots,
`undo` → restore, `foreach`/`each` → run.

Global: `-C <dir>` run as if from another directory, `--json` machine-readable
output, `POLY_ASCII=1` plain symbols, `NO_COLOR=1` no colour.

## Gate 1 — what it actually checks

The central insight from the problem definition: the dangerous predicate is
**locally checkable**, so it needs no trust in CI state or review state.

> *Is every submodule SHA in this root commit reachable from that submodule's
> protected branch?*

For every changed gitlink, `poly check` verifies:

- the target commit **exists** in the member repo;
- it is an **ancestor of the protected branch** — merged, not merely pushed;
- it is **not a regression** — the pointer does not move backwards;
- a **durable pin** exists (when `policy.requirePins` is on).

This catches the failure that is otherwise invisible until garbage collection:
a squash or rebase merge changes the SHA, so the recorded PR-head commit is not
what landed and the pointer is orphaned from birth.

```sh
poly check --head --strict     # in CI: exit 1 on any broken pointer
```

`--strict` is what turns Phase 1 reporting into Phase 3 enforcement. Without it
the gate reports and exits 0, which is the intended way to adopt it.

## The manifest

`poly init` writes `poly.json`:

```json
{
  "version": 1,
  "superproject": { "name": "root", "protectedBranches": ["main"] },
  "defaults": { "protectedBranch": "main", "remote": "origin" },
  "members": [
    {
      "name": "api",
      "path": "libs/api",
      "url": "git@github.com:org/api.git",
      "protectedBranch": "main",
      "remote": "origin",
      "dependsOn": []
    }
  ],
  "policy": {
    "blockPointerRegression": true,
    "requirePins": false,
    "requireMergedPointers": true
  }
}
```

`.gitmodules` stays the Git-level truth about where submodules live. `poly.json`
is the *policy* truth. A doctor check enforces that the two agree (invariant I6).

`dependsOn` is recorded now and used by the coordinator in Phase 5 to compute
merge order.

## Recovering work

```sh
poly snapshots                      # find it
poly restore 20260829-221452-50f7   # branch at the snapshot, nothing else touched
git -C libs/api diff poly/snap/20260829-221452-50f7
poly restore 20260829-221452-50f7 --apply --yes   # write the files back
```

`--apply` always snapshots the current state first and tells you that id, so
undoing a restore is another restore.

## What is not built yet

Deliberately, per the staging plan. Phases 1–3 deliver most of the safety value;
Phase 5 is the largest cost and should wait until the gates are boring and trusted.

| Phase | Status |
|---|---|
| 1 — Visibility: manifest, status, doctor, Gate 1 reporting | **built** |
| 2 — Ergonomics: fan-out, workspace sync, ChangeSet create/track | `sync` and `run` built; ChangeSet commands not yet |
| 3 — Enforcement: Gate 1 required, pinning, guardrails as code | `--strict` built; `poly pin` not yet |
| 4 — Integration: integration-build, independent-safety | not started |
| 5 — Coordination: saga coordinator, locks, queue, compensation | not started |
| 6 — Evidence: lockfiles, releases, coupling reports | not started |

Checks that need a platform API (GitHub/GitLab) are reported as *not checked*
rather than silently assumed — invariant I3 (review integrity) is the main one.

**This tool does not promise atomicity**, and never will. A partially-landed
change set is a real state; the goal is to make that window survivable and
visible, not to pretend it is closed.

## Releasing

Publishing is triggered by creating a **GitHub Release**, so the tag, the release
notes and the npm version are one deliberate act. `.github/workflows/publish.yml`
runs the tests, checks the tag against `package.json`, refuses to republish an
existing version, then publishes.

### One-time setup

1. **Create the npm scope.** Sign in to npmjs.com and create an org named
   `wanigasooriya-solutions` (free for public packages), or use your own username as the
   scope. The scope must exist before the first publish.

2. **Publish v0.1.0 once, by hand.** npm can only attach a trusted publisher to a
   package that already exists, so the first release is manual:

   ```sh
   npm login
   pnpm test
   npm publish --access public
   ```

   `--access public` is required on the first publish of a scoped package —
   scoped packages default to private, which needs a paid account.

3. **Turn on Trusted Publishing** (recommended — removes the token entirely).
   On npmjs.com go to the package → *Settings* → *Trusted Publisher*, and add:

   | Field | Value |
   |---|---|
   | Provider | GitHub Actions |
   | Organization / user | `wanigasooriya-solutions` |
   | Repository | `was-poly-repo-coordinator` |
   | Workflow filename | `publish.yml` |
   | Environment | `npm-publish` |

   Then create a GitHub environment named `npm-publish` under
   *Settings → Environments*. Add required reviewers there if you want a human
   approval gate before anything reaches the registry.

   Once this works, delete the `NPM_TOKEN` secret and the `NODE_AUTH_TOKEN` line
   from the workflow. Nothing long-lived remains.

   <details>
   <summary>Token instead of Trusted Publishing</summary>

   If you would rather use a token: npmjs.com → *Access Tokens* → *Generate* →
   **Granular access token**, scoped to this package only, with *Read and write*.
   Add it as the `NPM_TOKEN` repository secret. Rotate it on expiry — this is
   exactly the long-lived credential the specification argues against
   (Solution §2.8, §4 row 29), so prefer Trusted Publishing.
   </details>

### Every release after that

```sh
pnpm version patch        # or minor / major — bumps package.json and makes a git tag
git push --follow-tags
```

Then on GitHub: *Releases* → *Draft a new release* → pick the `v0.1.1` tag →
*Publish release*. The workflow takes it from there.

To rehearse without publishing, run the **Publish** workflow manually from the
Actions tab with *dry-run* left checked — it packs and validates, then stops.

### What ships

`files` in `package.json` limits the tarball to `bin/`, `src/`, `README.md` and
`LICENSE` — about 100 kB. Tests, `docs/*.docx` and `.poly/` are not published.
Check it any time with:

```sh
npm pack --dry-run
```

### Versioning

Pre-1.0, so treat the minor as breaking. The first stable release should wait
until Phase 3 (enforcement) is in use somewhere real, because that is the point
at which `poly check --strict` starts gating other people's merges and the
manifest format has to stop moving.

## Tests

```sh
pnpm test
```

The suite builds real git repositories and asserts the properties that matter:
snapshots capture untracked files, the working tree is unmodified, snapshotted
work survives `branch -D` + `reflog expire` + `gc --prune=now --aggressive`,
restores are reversible, destructive commands are refused, and Gate 1 catches
unmerged, missing and regressing pointers.
