# Contributing

## Local setup

```bash
npm install
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
* Python ≥ 3.9 for `runner.py`, stdlib only.

CI runs the matrix ends: Node 22.19 and 24, each against Python 3.9 and
3.13. If you rely on a newer Python feature in `runner.py`, raise the floor
in the CI matrix, `README.md`, and this file in the same commit.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) are
required, because releases are generated from them. The type drives the
version bump and the changelog:

| Prefix | Changelog section | Bump (pre-1.0) |
| --- | --- | --- |
| `feat:` | Features | minor |
| `fix:` | Bug Fixes | patch |
| `perf:` | Performance | patch |
| `refactor:` | Refactoring | patch |
| `docs:` | Documentation | patch |
| `test:`, `build:`, `ci:`, `chore:` | hidden | patch |
| any type with `!` or `BREAKING CHANGE:` | Breaking | minor while 0.x |

Write the body for someone who has to touch the same code in a year.
State what the code did before, what went wrong, and what evidence
justified the change. The existing history is the style reference.

## Branch protection

`main` requires a PR (0 approvals — review is encouraged, not enforced for
a project this size), a linear history, resolved conversations, and the
four CI legs passing. Force pushes and deletion are blocked. Admins are
not bound by the rules, deliberately: see the release caveat below.

Because linear history is required, merge commits are disabled repo-wide.
Squash and rebase merges both work.

## Releases

Releases are automated and nobody bumps a version by hand.

1. Merge PRs into `main`. Every commit runs CI.
2. `release-please` maintains a rolling release PR containing the version
   bump and generated `CHANGELOG.md`.
3. Merging that PR tags `vX.Y.Z` and publishes a GitHub Release.
4. The release event triggers `publish.yml`, which runs the typecheck and
   tests once more and publishes to npm via trusted publishing (OIDC).

No npm token exists in the repository. Publishing authority is bound to
the `publish.yml` workflow in this repo through npm's trusted publisher
configuration, and npm attaches provenance automatically.

**Caveat on the release PR.** GitHub does not run workflows for PRs opened
with the built-in `GITHUB_TOKEN`, which is what release-please uses. Its
PR therefore shows a CI run stuck at `action_required` with no jobs, and
the required checks never report. Two ways through:

* Open the run in the Actions tab and click *Approve and run*, then merge
  normally once the four legs pass.
* Or merge it as an admin, which the protection rules allow.

Neither skips testing: `publish.yml` re-runs the typecheck and the full
kernel suite against the tagged commit before it publishes, so an
unapproved release PR cannot ship untested code.

Wiring a PAT into release-please would make checks run on its PR, at the
cost of a long-lived credential in the repository. Not worth it here.

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

While `0.x`, those bump the minor.
