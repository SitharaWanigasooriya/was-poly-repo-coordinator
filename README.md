# poly — WAS Poly-Repo Coordination Tool

[![CI](https://github.com/SitharaWanigasooriya/was-poly-repo-coordinator/actions/workflows/ci.yml/badge.svg)](https://github.com/SitharaWanigasooriya/was-poly-repo-coordinator/actions/workflows/ci.yml)
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

## Update

If you installed with `pnpm add -g @wanigasooriya-solutions/poly`, upgrade with:

```sh
pnpm add -g @wanigasooriya-solutions/poly@latest
poly --version
```

If that reports the version you already had, you have hit one of the two causes
below. Both are pnpm behaviours rather than anything poly does.

### `@latest` installs an older version anyway

pnpm 11 applies a **minimum release age** to newly published packages: a version
uploaded minutes ago is held back, and `@latest` quietly resolves to the newest
release *older* than that cooldown. The install reports success and prints the
old version number, which is what makes this confusing.

Name the exact version to bypass the cooldown:

```sh
pnpm view @wanigasooriya-solutions/poly version    # what is really newest
pnpm add -g @wanigasooriya-solutions/poly@0.2.0    # install it by number
```

pnpm records the override in `minimumReleaseAgeExclude` in its global
`pnpm-workspace.yaml` and installs immediately. Waiting out the cooldown and
re-running `@latest` works too, if you would rather not pin.

### `pnpm add -g` fails without installing anything

```
[ERROR] The configured global bin directory "…\pnpm-global\bin" is not in PATH
```

pnpm refuses **every** global operation when its bin directory is missing from
PATH — it does not install and then fail to link, it does nothing at all and
exits non-zero. Any `pnpm add -g` run from such a shell was a no-op, so the
version never moved.

```sh
pnpm setup     # registers the bin dir; open a new shell afterwards
```

The directory must be on PATH exactly as pnpm reports it — on Windows that is
`%USERPROFILE%\pnpm-global\bin`, not the `pnpm-global` parent. A shell started
before `pnpm setup` ran keeps the old environment, so check in a fresh terminal.

<details>
<summary>Check what is actually installed</summary>

```sh
poly --version                                    # what is installed
pnpm view @wanigasooriya-solutions/poly version   # what is on npm
pnpm view @wanigasooriya-solutions/poly versions  # every published version
pnpm list -g --depth 0                            # what pnpm thinks it installed
```
</details>

<details>
<summary>npm / yarn / a linked clone</summary>

```sh
npm  install -g @wanigasooriya-solutions/poly@latest
yarn global upgrade @wanigasooriya-solutions/poly
```

If you installed with `pnpm link --global`, there is nothing to reinstall — the
global `poly` points at your working copy, so pulling is the update:

```sh
git pull
pnpm install
pnpm test
```
</details>

`pnpm dlx` / `npx` users are already on the latest release each run, though the
package-manager cache can serve an older copy; force a fresh fetch with
`pnpm dlx @wanigasooriya-solutions/poly@latest status` or
`npx @wanigasooriya-solutions/poly@latest status`.

Updating only replaces the CLI. It does not touch `poly.json`, `.poly/` or any
`refs/poly/safety/<id>` snapshot in your repos — snapshots taken by an older
version stay readable by the new one.

## Uninstall

Two separate things, and only the first is required: removing the CLI, and
removing what poly wrote into your repos.

### Remove the CLI

```sh
pnpm remove -g @wanigasooriya-solutions/poly
```

<details>
<summary>npm / yarn / a linked clone</summary>

```sh
npm  uninstall -g @wanigasooriya-solutions/poly
yarn global remove @wanigasooriya-solutions/poly

# if you installed with `pnpm link --global`, unlink from inside the clone
pnpm unlink --global
```
</details>

Check it is gone with `which poly` (`where.exe poly` on Windows) — it should
print nothing. There is nothing else to clean up on your machine: poly has no
runtime dependencies, no config directory and no cache. Nothing was run with
elevated privileges and no shell profile was modified.

`pnpm dlx` / `npx` users have nothing to uninstall; clear the package manager
cache if you want the download back (`pnpm store prune`, `npm cache clean --force`).

### What stays behind in your repos

Removing the CLI changes nothing inside your repositories. This is what poly
wrote there:

| What | Where | Cost of leaving it |
|---|---|---|
| `poly.json` | superproject root | one committed policy file |
| `.poly/snapshots.json` | superproject root, gitignored | a few kB, rebuildable from refs |
| `refs/poly/safety/<id>` | every repo, per snapshot | one commit object per repo |
| `poly/snap/<id>` branches | wherever you ran `poly restore` | a branch ref each |

**Leaving the safety refs in place is the recommended default.** For any
uncommitted or untracked work you snapshotted, they are the only copy. They cost
disk and nothing else: normal git operations never walk them, they are not
pushed unless you push them by name, and they do not affect `status`, `log` or
`gc`.

### Removing them anyway

Recover anything you still want **first** — once the refs are gone the tool that
made them is uninstalled too:

```sh
poly snapshots                                    # while poly is still installed
poly restore <id> --apply --yes                   # anything worth keeping
```

Deletion cannot be done through poly: its git wrapper refuses `update-ref -d`
and `branch -D` by design. So the commands below are plain git, run without any
of the protection the rest of this README describes. Read each one before you
run it.

```sh
rm poly.json
rm -rf .poly
```

Then, in the superproject and in **each** submodule — look before you delete:

```sh
git for-each-ref --format='%(refname)' 'refs/poly/**'          # what is there
git for-each-ref --format='%(refname)' 'refs/poly/**' \
  | while read -r ref; do git update-ref -d "$ref"; done       # delete it

git branch --list 'poly/snap/*'                                # restore branches
git branch -D <branch>
```

To sweep every submodule in one go:

```sh
git submodule foreach --recursive \
  "git for-each-ref --format='%(refname)' 'refs/poly/**' | while read -r ref; do git update-ref -d \"\$ref\"; done"
```

<details>
<summary>PowerShell</summary>

```powershell
Remove-Item poly.json
Remove-Item -Recurse -Force .poly
git for-each-ref --format='%(refname)' 'refs/poly/**' | ForEach-Object { git update-ref -d $_ }
```
</details>

Deleting the refs only makes the commits unreachable; the objects survive until
git collects them. If you want the snapshotted work actually gone — including
work that was never committed anywhere else — finish with:

```sh
git reflog expire --expire-unreachable=now --all
git gc --prune=now
```

That step is irreversible.

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

### Landing a change

| Command | What it does |
|---|---|
| `poly changeset new "why" [member...]` | Open a change set: which members carry a change, on which branch, from which pointer. Local only. |
| `poly changeset track [id]` | Recompute which members have merged into their protected branch. |
| `poly pin [member...]` | Pin the commit each submodule points at (`refs/poly/pins/…`) so gc can never collect it. `--push` publishes. |
| `poly land [--changeset id]` | Fast-forward submodules to what landed, in `dependsOn` order, run Gate 1, and commit the superproject only if it passes. Snapshots first. |

### Workspace

| Command | What it does |
|---|---|
| `poly sync` | Rescue orphaned commits, attach detached HEADs, fetch. Forces nothing. |
| `poly run <cmd>` | Run one command in every repo (snapshots first). See [Branching across every repo](#branching-across-every-repo). |
| `poly init` | Write `poly.json` from `.gitmodules`. |

Aliases: `st`/`s` → status, `dr` → doctor, `snap` → save, `ls`/`list` → snapshots,
`undo` → restore, `foreach`/`each` → run, `cs` → changeset.

Global: `-C <dir>` run as if from another directory, `--json` machine-readable
output, `POLY_ASCII=1` plain symbols, `NO_COLOR=1` no colour.

## Branching across every repo

There is no `poly checkout` and no `poly branch`. Fan-out is `poly run`, which
snapshots everything first, so creating a branch in every repo is:

```sh
poly run git checkout -b 1.x.x
```

Everything after the program's name — here `git` — is passed to it untouched, so
`-b` reaches git rather than being read as a flag to poly. Poly's own flags go
*before* that name:

```sh
poly run --members-only git checkout -b 1.x.x   # submodules only
poly run --keep-going   git checkout -b 1.x.x   # continue past a repo that fails
```

A `--` separator is still accepted and changes nothing, but it is not needed and
is best left out: PowerShell's parameter binder eats a bare `--` before the
`poly.ps1` shim ever passes `$args` on, so it is the one form that behaves
differently across shells.

`checkout -b` discards nothing: it carries uncommitted changes across, and git
refuses outright if anything would be overwritten. For a submodule sitting on a
detached HEAD it creates the branch at exactly the commit the superproject
pointer records, so nothing moves.

`poly run` spawns your command directly rather than through the git wrapper, so
the refusal list under [The promise](#the-promise) does **not** apply to what you
pass it. There, the snapshot is the safety net, not the blocklist.

Confirm where everything landed:

```sh
poly run git branch --show-current
```

Then decide about policy. Two things key off `protectedBranch` in `poly.json`:
`poly sync` re-attaches a detached HEAD to it, and `poly check` asks whether
pointers are merged into it. For a short-lived branch, leave it alone. If
`1.x.x` becomes the line you release from, change `defaults.protectedBranch`
— and any per-member override — to match.

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

### `--online` — review integrity (I3)

`poly check --online` (and `poly doctor --online`) adds the one check pure git
cannot do: for every pointer, did that commit reach the protected branch through
a *merged, approved* GitHub pull request — or did someone push straight to it?

It uses the `gh` CLI when it is installed and logged in, otherwise a token from
`GH_TOKEN` / `GITHUB_TOKEN`. Members whose URL is not on github.com, and anything
it cannot reach, are reported as *not checked* rather than assumed good. It stays
reporting-only until you set `"requireReviewedPointers": true` in `poly.json`.

### Making a pointer durable — `poly pin`

Reachable from `main` is not the same as durable: the branch can be reset and
history can be rewritten. `poly pin` writes `refs/poly/pins/<member>/<shortsha>`
in each member repo, which keeps the exact pinned commit reachable forever.

```sh
poly pin                 # pin every current pointer, locally
poly pin api --push      # pin one member and publish the ref to its remote
```

Turn on enforcement with `"requirePins": true` — then `poly check` fails on any
pointer without a pin. Nothing in poly ever deletes a pin.

## Landing a change set

Once each member PR has merged into its protected branch, `poly land` moves the
superproject pointers to match — in `dependsOn` order, so a build at any
intermediate commit still resolves.

```sh
poly changeset new "checkout: tax rounding" pos-ms-pricing-tax-service pos-ms-order-service
poly changeset track            # once the member PRs merge, this flips them to “merged”
poly land --changeset <id> --dry-run
poly land --changeset <id> --pin
```

For each member in order, `land` fetches the protected branch, checks the move is
a real fast-forward (the same predicates Gate 1 uses), fast-forwards the submodule
checkout, and stages the gitlink. Then it runs Gate 1 against the staged state and
**commits only if nothing is at error severity** — otherwise it stops with the
bumps staged and a pre-land snapshot to fall back to.

It takes a safety snapshot first. There is no `--keep-going`: a half-landed change
set is exactly the state the snapshot exists to make survivable, so it stops on
the first blocker. `land` never runs `git merge` on a member work branch and never
touches PRs — the member changes must already be merged.

The change set itself is optional (`poly land` with no `--changeset` bumps every
pointer that has a forward move available); it just records intent and is marked
`landed` once the superproject commit is made.

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
| 2 — Ergonomics: fan-out, workspace sync, ChangeSet create/track | **built** — `sync`, `run`, `poly changeset` |
| 3 — Enforcement: Gate 1 required, pinning, guardrails as code | **built** — `--strict`, `poly pin`, `poly check --online` (I3) |
| 4 — Integration: integration-build, independent-safety | not started |
| 5 — Coordination: saga coordinator, locks, queue, compensation | `poly land` bumps pointers in dependency order (no saga/locks) |
| 6 — Evidence: lockfiles, releases, coupling reports | not started |

`poly land` is a deliberate slice of Phase 5: the ordered pointer bump with a
Gate-1 stop, but no coordinator, no locks and no queue. It does not promise
atomicity — a partially-landed change set is still a real state, made visible and
survivable rather than pretended away.

Checks that need a platform API are opt-in: `poly check --online` runs I3
(review integrity) against GitHub, and anything it cannot reach — a non-github
remote, a missing token — is reported as *not checked* rather than assumed.
GitLab is not implemented.

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

`main` already carries the next version number — the previous release bumped it
(see [Version bumping](#version-bumping)). So a patch release is just a tag:

```sh
git pull
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v$VERSION" -m "v$VERSION"     # annotated: --follow-tags skips lightweight tags
git push origin main --follow-tags
```

For a minor or major release, set the number before tagging:

```sh
pnpm version minor --no-git-tag-version   # or major
git commit -am "Bump version to $(node -p "require('./package.json').version")"
git push
```

Then on GitHub: *Releases* → *Draft a new release* → pick the tag →
*Publish release*. The workflow takes it from there.

To rehearse without publishing, run the **Publish** workflow manually from the
Actions tab with *dry-run* left checked — it packs and validates, then stops.

### Version bumping

npm versions are immutable, so the number in `package.json` is spent the moment
a release publishes. Leaving it there means `main` describes a version that has
already shipped, and the next release opens by tripping the "version matches the
release tag" check.

The `bump` job in `publish.yml` closes that gap. After a successful publish it
raises `package.json` on `main` and pushes one
`Bump version to X after publishing Y [skip ci]` commit. It runs only when a
publish actually happened, so dry runs and skipped publishes leave `main` alone,
and it stands down if `main` has already been bumped by hand.

It moves the **patch** level by default. That is deliberate rather than lazy:
the job runs the instant a release ships, before any of the next release's
commits exist, so there is nothing to infer a larger bump from. The patch bump
is a placeholder that keeps `main` ahead of npm — raise it when the work that
earns a minor or major actually lands.

To choose the level explicitly, put a line anywhere in the release notes:

```
bump: minor
```

`major`, `minor`, `patch` and `none` are accepted, and `none` skips the bump
entirely. Alternatively run the workflow by hand from the Actions tab and pick
from the *bump* dropdown, which takes precedence over the release notes.

| Released | Level | `main` becomes |
|---|---|---|
| `0.2.0` | `patch` (default) | `0.2.1` |
| `0.2.0` | `minor` | `0.3.0` |
| `0.2.0` | `major` | `1.0.0` |
| `0.9.0` | `minor` | `0.10.0` |

The arithmetic is `npm version`, never a regex, so `0.9.0` → `0.10.0` and
prerelease tags behave the way semver says.

If `main` is a protected branch the push is rejected and the job fails with the
version it wanted to set, leaving the publish itself successful — bump by hand,
or give the job a bypass or an app token to keep it automatic.

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
