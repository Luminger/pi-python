# pi-python

A pi extension that gives the agent a persistent Python execution
environment.

Spawns one long-lived `python3 -u` subprocess per pi session, lazily on
first use. State is checkpointed to disk after every successful cell so
kernel restarts (and `/tree` navigation, including time travel and forks)
preserve variables, imports, and definitions.

## Tools the agent sees

| Tool | What it does |
| ---- | ------------ |
| `python` | Run one or more Python cells in the persistent kernel. Variables, imports, and definitions persist across calls and across kernel restarts (via on-disk checkpoints). Default timeout 120s, max 600s. |
| `python_set_interpreter` | Switch the kernel to a different python interpreter binary (e.g. `/path/to/.venv/bin/python` or `python3.12`). Kills the current kernel and spawns a new one. The namespace is wiped — checkpoints are **not** restored across an interpreter switch because pickled objects from one venv typically can't load into another. |

Both tools are registered with `executionMode: "sequential"` so the agent
never tries to run two cells (or a cell and an interpreter switch)
concurrently against the same kernel.

There is intentionally **no** `python_reset` tool. If the agent needs a
clean namespace it can call `python_set_interpreter` with the same path
(which discards state by design), run `globals().clear()` in a cell, or
ask the user to `/python-restart`.

## Slash commands the user sees

| Command | What it does |
| ------- | ------------ |
| `/python-status` | Kernel info (executable, pid, pickler) + checkpoint stats (count, total size, latest, branch coverage, fork inheritance) + active settings with their source. |
| `/python-restart` | Kill and respawn the kernel — interrupts a hung cell — then automatically restore the latest on-disk checkpoint reachable from the current branch leaf. State up through the last successful cell is preserved. |

## CLI flags

```
--python <path>     Override the interpreter pi-python should use.
                    Either an absolute path (/path/to/.venv/bin/python) or a
                    bare command name (python3.12) resolvable on PATH.
                    Smoke-tested at session_start; bad values are reported
                    and ignored (default resolution kicks in instead).
```

## How it works

```
┌──────────────┐   NDJSON over stdio   ┌──────────────────┐
│  pi (host)   │  ──────────────────▶  │  python3 runner  │
│  index.ts    │  ◀──────────────────  │  runner.py       │
│  kernel.ts   │     stream events     │  (persistent ns) │
│  settings.ts │                       └──────────────────┘
└──────────────┘
       │
       └─── ~/.pi/pi-python/<sessionId>/<leafId>.pkl
              checkpoints, keyed by session tree leaf
```

* **`runner.py`** — Python subprocess that reads NDJSON requests on stdin
  (`execute`, `checkpoint`, `restore`) and emits framed events on stdout.
  User code that prints is captured by replacing `sys.stdout` /
  `sys.stderr` with stream writers; control messages always go through
  `sys.__stdout__`.
* **`kernel.ts`** — Owns the subprocess. Parses the NDJSON stream, supports
  cancellation via `SIGINT`, respawns after a hard kill, exposes typed
  `execute()` / `checkpoint()` / `restore()` methods, and validates
  interpreter paths.
* **`settings.ts`** — Loader for `pi-python/settings.json` (global +
  project) and the `PI_PYTHON_*` env vars.
* **`index.ts`** — Glue: registers the tools and slash commands, owns the
  single kernel reference, hooks `message_end` for auto-checkpoint, hooks
  `session_tree` to kill the kernel for branch-restore, hooks
  `session_start` for fork checkpoint inheritance, and tears down on
  `session_shutdown`.

Cells inside one `python` call run sequentially; if a cell raises, later
cells are skipped (Jupyter notebook semantics). The trailing expression
of a cell, if any, has its `repr()` shown — same as a notebook cell.

## Checkpoints

After every successful `python` tool call the runner pickles the kernel
namespace and writes it to:

```
~/.pi/pi-python/<sessionId>/<leafId>.pkl
```

`<leafId>` is the id of the `python` toolResult message in pi's session
tree, so the checkpoint is naturally branch-bound: pi's `/fork`,
`/clone`, and `/tree` navigation all just change which leaf is "current",
and the right pickle gets restored on the next kernel spawn.

The active leaf after a `/tree` jump is rarely a `python` toolResult
itself — it's usually an assistant or user message somewhere on the
branch. So the restore lookup walks the active branch from leaf back to
root and loads the deepest ancestor that has a checkpoint on disk
(equivalently: the last `python` call you'd see if you scrolled up from
the current position). `/python-status` reports the resolved restore
source when it differs from the active leaf.

* **Pickler** — `dill` is used when importable in the active interpreter
  (covers interactively-defined classes, lambdas, closures), else stdlib
  `pickle` (covers basic types and module-defined objects only).
  `/python-status` shows which one is active.

  To get `dill`, install it into the **same interpreter the kernel runs**
  — i.e. whichever venv you've pointed `--python` /
  `python_set_interpreter` at, or your default if you haven't set one:

  ```bash
  /path/to/.venv/bin/pip install dill
  # or, if --python is unset and pi resolves to <cwd>/.venv/bin/python:
  source .venv/bin/activate && pip install dill
  ```

  The pickler is decided once at kernel startup, so after installing dill
  run `/python-restart` (or wait for the next spawn) to pick it up.
* **Per-key best-effort** — values that can't be pickled (open file
  handles, most ML model objects, lambdas without dill) are skipped
  individually rather than failing the whole checkpoint. Skipped names
  appear in `/python-status`.
* **Size cap** — pickles bigger than `pickleMaxBytes` (default 256 MB)
  are written to nothing and the leaf is marked "skipped" for the
  session so we don't keep retrying. Surfaced in `/python-status`.
* **Eviction** — at most 20 checkpoints per session are kept on disk;
  older off-branch checkpoints are evicted first. Active-branch
  checkpoints are never evicted.
* **Restore is automatic** on the next kernel spawn (cold start,
  `/python-restart`, post-`/tree` navigation). The restore target is the
  deepest ancestor of the active leaf that has a checkpoint on disk, so
  jumping to a position between two `python` calls picks up state as of
  the earlier call. `session_tree` also eagerly respawns when an
  ancestor checkpoint exists so the next agent `python` call doesn't pay
  Python startup + unpickle latency. Failures are silent (you keep going
  with an empty namespace) but recorded — see `/python-status`.
* **Forks inherit parent checkpoints.** When a session was forked from
  another (`SessionHeader.parentSession` is set) the `session_start`
  hook walks the fork's active branch and copies any of the parent's
  pickles whose key matches an entry on that branch into the fork's own
  checkpoint dir. Because pi's fork preserves entry ids verbatim, the
  copied pickle is a valid checkpoint for the fork's same-id entry.
  Existing files in the fork dir are never overwritten, so the operation
  is idempotent. `/python-status` shows how many pickles were inherited
  on the most recent fork. Off-branch parent pickles aren't copied; if
  you fork from `tr1` you don't inherit `tr2`'s namespace.
* **Switching interpreters discards state**: `python_set_interpreter`
  does not restore from a checkpoint, since cross-interpreter pickle
  loads typically fail.

## Settings

`pi-python` reads its own JSON settings file from two locations,
mirroring pi's own settings.json layout:

```
~/.pi/pi-python/settings.json          (global)
<cwd>/.pi/pi-python/settings.json      (project, overrides global)
```

Both files are optional; missing fields fall back to the lower-precedence
source. Schema:

```jsonc
{
  // Max bytes for an automatic checkpoint pickle. Larger pickles are
| `PI_PYTHON_MAX_TIMEOUT_SECONDS` | `maxTimeoutSeconds` (positive integer) |
| `PI_PYTHON_INTERRUPT_GRACE_MS` | `interruptGraceMs` (non-negative integer; 0 disables auto-kill) |
  // skipped (and the leaf is marked so we don't retry). Default: 256 MB.
  "pickleMaxBytes": 268435456,

  // When auto-resolving the interpreter, walk from `cwd` upward looking
  // for a venv. Stops at the first match, or at a `.git` repo root
  // (never crosses repo boundaries). Default: true.
  "venvParentWalk": true,

  // Directory names checked at each level when auto-resolving the
  // interpreter. A user-provided list FULLY OVERWRITES the default —
  // setting `[".my-env"]` means *only* `.my-env` is searched, the
  // defaults below are not appended. Set to `[]` to disable venv
  // autodiscovery entirely. Default: [".venv", "venv"].
  "venvDirNames": [".venv", "venv"]
}
```

Precedence (highest wins): env var → project file → global file →
built-in default.

### Environment variable overrides

| Env var | Setting it overrides |
| ------- | -------------------- |
| `PI_PYTHON_PICKLE_MAX_BYTES` | `pickleMaxBytes` (positive integer, in bytes) |
| `PI_PYTHON_VENV_PARENT_WALK` | `venvParentWalk` (boolean: `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`) |
| `PI_PYTHON_VENV_DIR_NAMES` | `venvDirNames` (comma-separated; an explicitly-empty value disables autodiscovery; leave the env var unset to use the default) |
| `PI_PYTHON` | Default interpreter (same role as `--python`, lower precedence than the flag and `python_set_interpreter`) |

## Interpreter resolution

In order of priority:

1. `python_set_interpreter` (if the agent has switched mid-session)
2. `--python <path>` CLI flag
3. `$PI_PYTHON` env var
4. `$VIRTUAL_ENV/bin/python`
5. A venv directory named in `venvDirNames` (default: `.venv`, `venv`)
   found in `cwd`. If `venvParentWalk` is true (default), the search
   ascends from `cwd` until a venv is found or a `.git` repo root is
   hit — useful for uv-workspace layouts where the venv lives at the
   workspace root, not next to every member.
6. `python3` on `PATH`

`python_set_interpreter` and the `--python` flag both accept either an
absolute path to a binary or a bare command name on `PATH`. Directories
are rejected with a hint pointing at the binary path inside.

API-key-shaped env vars (`OPENAI_*`, `ANTHROPIC_*`, `*_API_KEY`,
`*_TOKEN`, `*_SECRET`, etc.) are stripped from the subprocess env so
LLM-generated code that reads `os.environ` can't exfiltrate them.

## Install

The repo doubles as the extension package, so `npm install` here pulls in
the typings and dev tooling, and `npm run check` typechecks the TS
files. `npm test` runs the end-to-end checkpoint/restore test suite (no
mocks; uses real `SessionManager` + real `PythonKernel`).

```bash
npm install
npm run check
npm test
```

For pi to pick the extension up, place this directory under one of pi's
auto-discovery roots:

```bash
# global (all projects)
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-python

# or project-local
mkdir -p .pi/extensions
ln -s "$(pwd)" .pi/extensions/pi-python
```

Then `/reload` inside pi (or restart). `/python-status` will confirm
it's loaded. The `--python <path>` flag in `pi --help` is also a quick
check — it's registered by this extension, so its presence means
pi-python loaded.

For one-off testing without installing:

```bash
pi -e ./index.ts
```

## Tool reference

### `python`

```ts
{
  cells: Array<{ code: string; title?: string }>;  // ≥1
  timeout?: number;   // seconds, default 120, clamped to 1..600
  reset?: boolean;    // drop the namespace before the first cell
  cwd?: string;       // working dir for this call
}
```

Result includes per-cell stdout, stderr, last-expression value (when the
cell ends in a bare expression), and a formatted traceback for failures.
Output is truncated with `truncateTail` (50 KB / 2000 lines) so the LLM
sees the most recent output when runs are noisy.

### `python_set_interpreter`

```ts
{
  path: string;       // absolute path or bare PATH command name
}
```

Validates the path, kills the current kernel, spawns a new one with the
requested interpreter, and reports the resolved executable, version, and
new pid. Throws (with the validation error) if the path doesn't point at
a runnable interpreter.

## Known limitations

* **No rich display** — only text stdout/stderr and `repr()` of trailing
  expressions. No `image/png` / `text/markdown` envelopes (yet).
* **`input()` is not supported** — there is no interactive stdin. Pass
  data through variables instead.
* **`subprocess` output via raw fd 1** — `subprocess.run(...,
  capture_output=True)` works, but child processes that write directly
  to fd 1 bypass our `sys.stdout` shadowing.
* **One kernel per pi process** — no shared gateway across multiple pi
  instances. If you need that, the next step is binding the kernel to a
  Unix socket per session file.
* **Orphaned checkpoint dirs** — when a pi session is deleted, its
  `~/.pi/pi-python/<sessionId>/` dir stays behind. No automatic cleanup
  yet.

The architecture is borrowed in spirit from
[oh-my-pi's IPython kernel runtime](https://github.com/can1357/oh-my-pi/blob/main/docs/python-repl.md),
with the heavy Jupyter Kernel Gateway replaced by a stdio NDJSON protocol
so this works with a stock Python install. (oh-my-pi's runtime offers an
interactive REPL too; pi-python intentionally does not.)
