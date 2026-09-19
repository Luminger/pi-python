# Contributing

## Local setup

```bash
npm ci
npm run check   # tsc --noEmit
npm test        # drives a real PythonKernel, no mocks
```

The test suite spawns real `python3` subprocesses and sends real signals.
It is not hermetic by design — signal handling is the thing under test, so
faking it would test nothing. Expect a few seconds of wall clock for the
timeout scenarios.

To run pi against your working copy without installing:

```bash
pi -e ./index.ts
```

## Supported runtimes

* Node ≥ 22.19 (pi core's floor; the test script needs
  `--experimental-transform-types`).
* Bun ≥ 1.3 when using Bun as the TypeScript host.
* Python ≥ 3.9 for `runner.py`, stdlib only.

CI cross-products every claimed Python version (3.9–3.14), every modern
supported Node line (22, 24, 26, plus the exact 22.19 floor), Bun 1.3 and
1.4, and all three GitHub-hosted OS families (Linux, macOS, Windows): 108
jobs per run. Python 3.9 remains despite upstream EOL because it is still
the documented floor.

When changing a runtime floor or support range, update `package.json`, the
CI matrix, `README.md`, and this file together.

## Commit messages

Commits landing on `main` must use [Conventional
Commits](https://www.conventionalcommits.org/en/v1.0.0/), because
release-please generates versions and changelogs from them. For squash
merges, the PR title becomes that commit message and must follow the
convention. The type drives the version bump and changelog section:

| Prefix | Changelog section | Bump (pre-1.0) |
| --- | --- | --- |
| `feat:` | Features | patch |
| `fix:` | Bug Fixes | patch |
| `perf:` | Performance | patch |
| `refactor:` | Refactoring | patch |
| `docs:` | Documentation | patch |
| `test:`, `build:`, `ci:`, `chore:` | hidden | no release on their own |
| any type with `!` or `BREAKING CHANGE:` | Breaking | minor while 0.x |

Write the body for someone who has to touch the same code in a year.
State what the code did before, what went wrong, and what evidence
justified the change. The existing history is the style reference.

## Branch protection

`main` requires a PR (0 approvals — review is encouraged, not enforced for
a project this size), a linear history, resolved conversations, and the
`CI gate` check. That stable gate succeeds only when the entire dynamic
runtime/OS matrix passes. Force pushes and deletion are blocked. Admins
are not bound by the rules, deliberately: see the release caveat below.

Because linear history is required, merge commits are disabled repo-wide.
Squash and rebase merges both work.

## Releases

Releases are automated and nobody bumps a version by hand.

1. Merge PRs into `main`. Every commit runs CI.
2. `release-please` maintains a rolling release PR containing the version
   bump and generated `CHANGELOG.md`.
3. Merging that PR tags `vX.Y.Z` and publishes a GitHub Release.
4. The same workflow run then checks out the tag, re-runs the typecheck
   and tests, and publishes to npm via trusted publishing (OIDC).

Step 4 lives in `release-please.yml` rather than a separate `on: release`
workflow for a reason worth not rediscovering: a release created with the
built-in `GITHUB_TOKEN` does not trigger further workflow runs, so a
dedicated publish workflow never fires at all. Publishing from the run
that created the release sidesteps that, because that run was started by
a human push to `main`.

No npm token exists in the repository. Publishing authority is bound to
the `release-please.yml` workflow in this repo through npm's trusted
publisher configuration, and npm attaches provenance automatically.

**Caveat on the release PR.** GitHub does not run workflows for PRs opened
with the built-in `GITHUB_TOKEN`, which is what release-please uses. Its
PR therefore shows a CI run stuck at `action_required` with no jobs, and
the required checks never report. Two ways through:

* Open the run in the Actions tab and click *Approve and run*, then merge
  normally once the full matrix and `CI gate` pass.
* Or merge it as an admin, which the protection rules allow.

Neither skips testing: the publish job re-runs the typecheck and the full
kernel suite against the tagged commit before it publishes, so an
unapproved release PR cannot ship untested code.

Wiring a PAT into release-please would make checks run on its PR, at the
cost of maintaining a long-lived repository secret. One explicit approval
per release is the simpler tradeoff here.

## What counts as breaking

Not the tool schema. The model reads it fresh every session and adapts to
renamed tools and parameters without anyone noticing; there is no
downstream code calling `python(cells=[...])` by hand. Reshape the
agent-facing surface whenever a better shape appears.

Reserve `!` / `BREAKING CHANGE:` for changes that break a working install
without the user doing anything:

* renaming or dropping a `settings.json` key or a `PI_PYTHON_*` env var
* changing interpreter resolution order, so a different python is selected
* raising the Node or Python floor
* changing whether the namespace survives a given event

While `0.x`, those bump the minor. Everything else — features included —
bumps the patch, so ordinary releases are `0.3.1`, `0.3.2`, and so on.
