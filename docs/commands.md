# poly — Command Handbook

Quick reference for every command, flag, exit code and alias.

The tool is self-documenting: `poly help` lists everything, `poly help <command>`
gives the detail for one. This page is the same information on a single screen,
plus exit codes and the recipes that string commands together.

For *why* the commands work the way they do — the invariants, the two gates, the
safety model — see the [README](../README.md) and the
[Problem](problem.docx) / [Solution](solution.docx) definitions.

---

## At a glance

**Writes** says what a command can change. Everything marked *snapshot first*
takes a restorable safety snapshot before it touches anything, and refuses to
continue if that snapshot fails.

### Every day

| Command | Writes | What it answers |
|---|---|---|
| [`poly status`](#poly-status) | nothing | Where does every repo stand right now? |
| [`poly check`](#poly-check) | nothing | Is this state safe to merge? (Gate 1) |
| [`poly doctor`](#poly-doctor) | nothing | What exactly is wrong, and how do I fix it? |

### Your safety net

| Command | Writes | What it answers |
|---|---|---|
| [`poly save`](#poly-save) | safety refs | Capture everything, including untracked files. |
| [`poly snapshots`](#poly-snapshots) | nothing | What can I go back to? |
| [`poly restore`](#poly-restore) | branch refs; worktree with `--apply` *(snapshot first)* | Bring a snapshot back. |

### Landing a change

| Command | Writes | What it answers |
|---|---|---|
| [`poly changeset`](#poly-changeset) | `.poly/` only | Which members carry this one change, and have they landed? |
| [`poly pr`](#poly-pr) | remote PRs only | Open the member + superproject pull requests. |
| [`poly pin`](#poly-pin) | pin refs *(snapshot first)* | Make each pointer permanently reachable. |
| [`poly land`](#poly-land) | submodules + a commit *(snapshot first)* | Bump pointers to what merged, gated by Gate 1. |
| [`poly land --self`](#poly-land---self) | the protected branch ref *(snapshot first)* | Fast-forward the superproject's own branch. |

### Workspace

| Command | Writes | What it answers |
|---|---|---|
| [`poly sync`](#poly-sync) | branches, remote-tracking refs *(snapshot first)* | Re-attach detached HEADs, rescue orphans, fetch. |
| [`poly run`](#poly-run) | whatever your command does *(snapshot first)* | Run one command in every repo. |
| [`poly init`](#poly-init) | `poly.json` | Create the manifest from `.gitmodules`. |

### Aliases

| Alias | Command |
|---|---|
| `st`, `s` | `status` |
| `dr` | `doctor` |
| `snap` | `save` |
| `ls`, `list` | `snapshots` |
| `undo` | `restore` |
| `cs` | `changeset` |
| `pull-request` | `pr` |
| `foreach`, `each` | `run` |

---

## Global flags and environment

| Flag | Effect |
|---|---|
| `-C <dir>` | Run as if from `<dir>` instead of the current directory. |
| `--json` | Machine-readable output. Supported by `status`, `check`, `doctor`, `snapshots`, `pin`. |
| `--help`, `-h` | Detail for the command in front of it (`poly land --help`). |
| `--version`, `-V` | Print the version and exit. |

| Variable | Effect |
|---|---|
| `POLY_STRICT=1` | Same as `poly check --strict`. |
| `POLY_ONLINE=1` | Same as `--online` on `check` and `doctor`. |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub auth for `--online` and `poly pr`, used when the `gh` CLI is not available. `gh` wins when it is installed and logged in. |
| `POLY_ASCII=1` | Plain ASCII symbols instead of Unicode. |
| `NO_COLOR=1` / `POLY_NO_COLOR=1` | Disable colour. |
| `POLY_DEBUG=1` | Print a stack trace on an unexpected error. |

### Flag parsing

- `--flag value` and `--flag=value` are both accepted for flags that take a value.
- `--no-<flag>` negates: `--no-fetch`, `--no-commit`, `--no-verify`, `--no-save`.
- Everything after `--` is positional, verbatim.
- For `poly run`, everything after the wrapped program's name is passed through
  untouched — so poly's own flags go **before** it:
  `poly run --members-only git checkout -b 1.x.x`.

---

## Exit codes

The general contract:

| Code | Meaning |
|---|---|
| `0` | Fine. |
| `1` | The command ran and found problems, or partially failed. |
| `2` | Usage error, refused precondition, or an unexpected error. |

Per command, `1` means:

| Command | Exits `1` when |
|---|---|
| `status` | Anything is at **error** severity. Always — there is no `--strict` here. |
| `check` | Errors exist **and** `--strict` was passed. Reporting mode otherwise.<br>⚠️ `--json` currently exits `1` on errors regardless of `--strict`. |
| `doctor` | Anything is at error severity. |
| `save` | The snapshot failed in some repo. |
| `restore` | A repo failed to restore, or the pre-restore snapshot failed. |
| `sync` | Any repo reported a problem. |
| `run` | Any repo's command failed. |
| `pin` | A pin failed to write or push. |
| `pr` | A PR failed to open, or a branch needs pushing first (outside `--dry-run`). |
| `land` | Gate 1 blocked the commit, a move was not a fast-forward, or a push failed. |
| `init` | The manifest already exists and neither `--refresh` nor `--force` was given. |

`poly check --head --strict` is the CI invocation: it is the only combination that
turns Gate 1 into a build failure.

---

## Every day

### `poly status`

```
poly status [--json]
```

Aliases: `st`, `s`. Read-only.

One screen for the whole workspace: the superproject's branch and ahead/behind,
then a row per member with branch, uncommitted work and pointer verdict.

Runs **all** the checks — Gate 1, manifest coherence (I6) and local workspace
hazards (E23 detached HEAD, E24 uncommitted work) — but prints only the top five
findings, titles only. For detail and fixes, use `poly doctor`.

Also prints the safety-net line: when the last snapshot was taken, how many repos
are dirty, how many pointers are pinned, and the next move worth making
(`poly save`, `poly pin`, `poly doctor`, `poly land --self`).

> **status vs check.** `status` is the human dashboard and covers every check;
> `check` is the CI gate and covers pointer integrity only, in full detail. Their
> exit codes differ too: `status` fails on errors by default, `check` does not
> until `--strict`.

---

### `poly check`

```
poly check [--head] [--strict] [--online] [--json]
```

Read-only. **Gate 1 — pointer integrity.**

Answers one question mechanically, with no trust in CI state or review state:

> Is every submodule SHA in this superproject state reachable from that
> submodule's protected branch?

For every changed gitlink it verifies the target commit **exists**, is an
**ancestor of the protected branch** (merged, not merely pushed), is **not a
regression**, and — when `policy.requirePins` is on — has a **durable pin**.

| Flag | Effect |
|---|---|
| `--head` | Check the last commit instead of the staged state. |
| `--strict` | Exit `1` on problems. Without it the gate reports and exits `0`. |
| `--online` | Also run I3 (review integrity) against GitHub. |
| `--json` | Machine-readable output for CI. |

Every finding is printed in full — invariant tag, detail, and a `fix:` line.

**`--online` (I3)** asks the one thing pure git cannot: did this commit reach the
protected branch through a *merged, approved* pull request, or did someone push
straight to it? Uses `gh` when installed and logged in, else `GH_TOKEN` /
`GITHUB_TOKEN`. Non-github.com members, and anything it cannot reach, are reported
as *not checked* rather than assumed good. It stays reporting-only until
`"requireReviewedPointers": true` is set in `poly.json`.

```sh
poly check --head --strict     # in CI
poly check --online            # add review integrity
```

**Checking a branch other than the one you are on.** `poly check` reads the index
or `HEAD`, not an arbitrary ref. To check another branch's recorded pointers
without disturbing your working tree, run it from a worktree:

```sh
git worktree add ../super-1x release/1.x
poly -C ../super-1x check --head
git worktree remove ../super-1x
```

Or just list the gitlink SHAs on any branch with plain git — no checkout, no
Gate 1:

```sh
git ls-tree -r release/1.x | awk '$2 == "commit"'   # 160000 commit <sha>  <path>
git ls-tree release/1.x libs/api                    # one submodule
git diff --submodule=short main release/1.x         # pointers on main vs the branch
```

---

### `poly doctor`

```
poly doctor [--online] [--json]
```

Alias: `dr`. Read-only.

Everything `status` checks, but grouped by invariant, complete rather than
truncated, and with a suggested fix on each finding. Also reports pin coverage and
the state of the safety net. This is where you go once `status` says something is
wrong.

| Flag | Effect |
|---|---|
| `--online` | Also check I3 (review integrity) against GitHub. |

---

## Your safety net

### `poly save`

```
poly save [label...] [--all-files]
```

Alias: `snap`.

Writes one real commit object per repo under `refs/poly/safety/<id>`, capturing
committed, uncommitted **and untracked** work. Because they are refs, `git gc`
cannot collect them and deleting a branch cannot orphan them.

Built through a temporary index, so **your working tree is never touched** —
nothing is stashed or removed, unlike `git stash`.

| Flag | Effect |
|---|---|
| `--all-files` | Also capture `.gitignore`d files. Off by default; it sweeps up `node_modules` and build output. |

```sh
poly save "before the big refactor"
```

---

### `poly snapshots`

```
poly snapshots [--all] [--json]
```

Aliases: `ls`, `list`. Read-only.

Reads `refs/poly/safety/*` from every repo, so snapshots stay discoverable even if
`.poly/` is deleted. Shows the 20 most recent; `--all` shows every one.

Nothing in poly ever deletes a snapshot.

---

### `poly restore`

```
poly restore [<id>|latest] [--apply] [--yes] [--branch <name>]
```

Alias: `undo`.

Default is non-destructive: it creates a branch at the snapshot commit in each
repo and changes nothing else. Inspect it, diff it, cherry-pick from it.

| Flag | Effect |
|---|---|
| `--apply` | Write the snapshot files back into the working tree. Snapshots the current state first, so this is itself undoable. Never deletes files that exist now. |
| `--yes` | Skip the confirmation for `--apply`. |
| `--branch <name>` | Name for the created branch (default `poly/snap/<id>`). |

With no id the most recent snapshot is used, and an id prefix is enough.

```sh
poly restore 20260829-221452-50f7                  # branch only
git -C libs/api diff poly/snap/20260829-221452-50f7
poly restore 20260829-221452-50f7 --apply --yes    # write the files back
```

---

## Landing a change

### `poly changeset`

```
poly changeset new "<title>" [member...]
poly changeset list
poly changeset show [<id>]
poly changeset track [<id>]
```

Alias: `cs`. Local only — stored under `.poly/`, nothing committed, no repo touched.

Records which members carry one logical change, on which branch, and what pointer
each started at, so you can watch the pieces land and know when the whole thing is
safe to bump.

| Subcommand | Effect |
|---|---|
| `new "<title>" [member...]` | Open one. With no members named, every member on a feature branch or with a dirty tree is included. |
| `list` | Every change set, newest first. |
| `show [<id>]` | Per-member state (default: the newest). |
| `track [<id>]` | Recompute merge state from the repos — flips members to *merged* once their PRs land. |

---

### `poly pr`

```
poly pr [<member>...] [--changeset <id>] [--base <branch>] [--title <t>]
        [--body <b>] [--draft] [--members-only] [--dry-run]
```

Alias: `pull-request`. **Writes nothing to any local repository.**

For the superproject and every member repo on a feature branch, opens a PR from
the current branch into that repo's protected branch. A PR that is already open is
reported, not duplicated.

It **will not push for you**: a branch that is not on its remote, or is ahead of
it, is skipped with the exact `git push -u …` to run. Members whose remote is not
on github.com are skipped.

| Flag | Effect |
|---|---|
| `<member>...` | These members only (default: every repo on a feature branch). |
| `--changeset <id>` | Scope to that change set; the generated PR body links back to it. |
| `--base <branch>` | Target branch for every PR (default: each repo's protected branch). |
| `--title <t>` | PR title (default: the branch's last commit subject). |
| `--body <b>` | PR body. |
| `--draft` | Open as draft PRs. |
| `--members-only` | Skip the superproject. |
| `--dry-run` | Show the plan, open nothing. |

Auth is the same as `poly check --online`: the `gh` CLI when installed and logged
in, otherwise `GH_TOKEN` / `GITHUB_TOKEN`.

There is no built-in direction. `poly pr` opens a PR **from the branch you are on
into `--base`**; the only rule is that the two differ. So a release line works
both ways:

```sh
# forward-port a hotfix:  1.x.x → main
git switch 1.x.x
git push                             # the head branch must be on its remote
poly pr --base main

# back-merge into the release line:  main → 1.x.x
git switch main
poly pr --base 1.x.x

# narrow the fan-out
poly pr --base main --members-only   # skip the superproject
poly pr api --base 1.x.x             # only this member, from its current branch
```

With no `--changeset` or member names, `poly pr` targets every repo, so members
still on `main` show up as skipped (`on main — check out a feature branch`) —
name the repos you mean for a release-line PR. GitHub rejects a PR with nothing
to merge (`422 No commits between …`); `poly pr` surfaces that as a failed row,
not a crash.

---

### `poly pin`

```
poly pin [<member>...] [--push] [--head] [--json]
```

Snapshots first.

Reachable from `main` is not the same as durable — a branch can be reset and
history can be rewritten. `poly pin` writes `refs/poly/pins/<member>/<shortsha>`
in each member repo, which keeps that exact commit reachable forever.

| Flag | Effect |
|---|---|
| `<member>...` | Pin only these members (default: every recorded pointer). |
| `--push` | Also push the pin refs to each member remote. |
| `--head` | Pin what the last commit records, not the staged state. |

Set `"requirePins": true` in `poly.json` to make `poly check` fail on any pointer
without a pin. Nothing in poly ever deletes a pin.

---

### `poly land`

```
poly land [--changeset <id>] [--dry-run] [--no-commit] [--pin] [--pin-push]
          [--message <m>] [--force]
```

Snapshots first.

A pointer-bumper, **not** a merge tool: every member change must already be merged
into its protected branch. For each member in `dependsOn` order it fetches, checks
the move is a real fast-forward, fast-forwards the submodule checkout, and stages
the gitlink. Then it runs Gate 1 against the staged state and commits **only if
nothing is at error severity** — otherwise it stops with the bumps staged and a
pre-land snapshot to fall back to.

There is no `--keep-going`: a half-landed change set is exactly the state the
snapshot exists to make survivable, so it stops on the first blocker. It never runs
`git merge` on a member work branch and never touches PRs.

| Flag | Effect |
|---|---|
| `--changeset <id>` | Land only that change set's members, and mark it landed. |
| `--dry-run` | Show the plan, touch nothing. |
| `--no-commit` | Stage the bumps and stop before the commit. |
| `--pin` | Pin each landed commit. |
| `--pin-push` | Pin each landed commit and publish the pin refs. |
| `--message <m>` | Override the generated commit message. |
| `--force` | Proceed even if the superproject has unrelated changes. |

The change set is optional — plain `poly land` bumps every pointer that has a
forward move available.

---

### `poly land --self`

```
poly land --self [--changeset <id>] [--switch] [--push] [--dry-run]
                 [--no-verify] [--force]
poly land --self --undo
```

Snapshots first.

`poly land` bumps pointers; it does not move the superproject's own branch. Once
the bump commit — or any superproject work — is on a feature branch and Gate 1 is
green, `--self` fast-forwards the protected branch to it.

**It only ever fast-forwards.** If `main` has moved on it refuses and points you at
`poly sync --pull`; poly never rebases and never makes a merge that can conflict.
The move is a single ref update: no checkout unless `--switch`, no merge commit.

`poly status` tells you when this is the next move: *"bump/tax-rounding is 3
commits ahead of main — `poly land --self` fast-forwards it"*.

| Flag | Effect |
|---|---|
| `--changeset <id>` | Refuse unless that change set has fully merged; mark it landed once the branch moves. |
| `--switch` | Check out the protected branch afterwards. |
| `--push` | Push the protected branch to its remote. Never forced. |
| `--dry-run` | Show the move, change nothing. |
| `--no-verify` | Skip the Gate 1 check. |
| `--force` | Proceed despite a dirty tree or an unmerged change set. |
| `--undo` | Walk the protected branch back to where the last `--self` land found it. |

The before/after positions are saved under `refs/poly/land/<branch>/`, which is
what makes `--undo` possible. Undo is non-destructive — the un-landed commits stay
on the branch you landed from — and refuses if anything landed on the protected
branch since. It never force-pushes, so a `--self --push` that already reached the
remote has to be walked back there by hand.

---

## Workspace

### `poly sync`

```
poly sync [--no-fetch] [--pull]
```

Snapshots first.

Commits sitting on a detached HEAD that belong to no branch are given a
`poly/rescue/<sha>` branch *before anything else happens*. A detached HEAD is
re-attached only when nothing would be lost.

| Flag | Effect |
|---|---|
| `--no-fetch` | Skip the fetch (fetch only updates remote-tracking refs). |
| `--pull` | Fast-forward branches that are behind. Never merges, so it can never conflict; diverged branches are reported instead. |

---

### `poly run`

```
poly run [--members-only] [--keep-going] [--no-save] <command...>
```

Aliases: `foreach`, `each`. Snapshots first.

Runs one command in every repo. This is the fan-out primitive — there is no
`poly checkout` and no `poly branch`, because this covers them:

```sh
poly run git checkout -b 1.x.x                   # branch everywhere
poly run --members-only git checkout -b 1.x.x    # submodules only
poly run --keep-going npm test                   # continue past a failure
poly run git branch --show-current               # confirm where everything landed
```

| Flag | Effect |
|---|---|
| `--members-only` | Skip the superproject. |
| `--keep-going` | Continue after a repo fails (default: stop). |
| `--no-save` | Skip the snapshot. Not recommended. |

Everything after the program's name is passed through untouched, so `-b` reaches
git rather than being read as a flag to poly. Poly's own flags go before that name.

> `poly run` spawns your command directly rather than through the git wrapper, so
> the refusal list under [The promise](../README.md#the-promise) does **not** apply
> to what you pass it. Here the snapshot is the safety net, not the blocklist.

---

### `poly init`

```
poly init [--refresh] [--force]
```

Discovers submodules from `.gitmodules` and writes `poly.json`. It only ever writes
that one file.

| Flag | Effect |
|---|---|
| `--refresh` | Keep your edits, merge in submodules added since. |
| `--force` | Overwrite the existing manifest completely. |

Without either flag it refuses to overwrite an existing manifest.

---

## Recipes

**Getting started**

```sh
cd your-superproject
poly init
poly status
poly check
```

**Before anything risky**

```sh
poly save "before the big refactor"
poly snapshots
```

**Land a change across several members**

```sh
poly changeset new "checkout: tax rounding" pos-ms-pricing-tax-service pos-ms-order-service
poly run git push -u origin HEAD     # push the work branches; poly pr will not
poly pr --changeset <id>             # open the member + superproject PRs
poly changeset track                 # once they merge, flips members to “merged”
poly land --changeset <id> --dry-run
poly land --changeset <id> --pin
```

**Land the superproject branch itself**

```sh
poly land --self --dry-run
poly land --self --changeset <id> --push
poly land --self --undo              # if it was wrong
```

**Release-branch PRs (both directions)**

```sh
# cut the release line from main
poly run git checkout -b 1.x.x
poly run git push -u origin 1.x.x

# a hotfix lands on 1.x.x → forward-port it to main
git -C libs/api switch 1.x.x && git -C libs/api push
poly pr api --base main              # 1.x.x → main, just this member

# bring a change from main back onto the release line
git -C libs/api switch main
poly pr api --base 1.x.x             # main → 1.x.x
```

**In CI**

```sh
poly check --head --strict
poly check --head --strict --online  # add review integrity
```

**Check another branch's submodule pointers**

```sh
git worktree add ../super-1x release/1.x
poly -C ../super-1x check --head          # full Gate 1 on that branch
git worktree remove ../super-1x

# or, pure git — just the recorded SHAs, no checkout
git ls-tree -r release/1.x | awk '$2 == "commit"'
git diff --submodule=short main release/1.x
```

**Branch everywhere**

```sh
poly run git checkout -b 1.x.x
poly run git branch --show-current
```

**Recover work**

```sh
poly snapshots
poly restore <id>                    # branch at the snapshot, nothing else touched
poly restore <id> --apply --yes      # write the files back
```

**Something is wrong**

```sh
poly doctor
poly sync                            # detached HEADs, orphaned commits
poly sync --pull                     # fast-forward what is behind
```
