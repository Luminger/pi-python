# pi-python

A pi extension that gives the agent a persistent Python execution
environment.

Spawns one long-lived `python3 -u` subprocess per pi session, lazily on
first use. Variables, imports, and definitions live in that process and
persist across tool calls for as long as it does.

The namespace is deliberately **not** persisted to disk. An earlier
version pickled the whole namespace after every call so kernel restarts
and `/tree` navigation could resurrect it; in practice the restores were
rarely useful, while the snapshots cost a full serialization per call and
grew to 80 GB across 421 sessions. Re-running the cells is cheaper and
more predictable. See *Known limitations*.

## Tools the agent sees

| Tool | What it does |
| ---- | ------------ |
| `python` | Run one or more Python cells in the persistent kernel. Variables, imports, and definitions persist across calls for the life of the kernel process. Default timeout 120s, max 3600s (configurable via `maxTimeoutSeconds`). On timeout the runner is SIGINT'd; the kernel catches KeyboardInterrupt and the namespace from any cells that completed before the interrupt survives. |
| `python_set_interpreter` | Switch the kernel to a different python interpreter binary (e.g. `/path/to/.venv/bin/python` or `python3.12`). Kills the current kernel and spawns a new one, so the namespace is wiped. |

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
| `/python-status` | Kernel info (executable, pid, cwd, alive) + active settings with their source. |
| `/python-restart` | Kill and respawn the kernel — interrupts a hung cell. The namespace is discarded; re-run the cells you still need. |

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
```

* **`runner.py`** — Python subprocess that reads NDJSON requests on stdin
  (`execute`) and emits framed events on stdout.
  User code that prints is captured by replacing `sys.stdout` /
  `sys.stderr` with stream writers; control messages always go through
  `sys.__stdout__`.
* **`kernel.ts`** — Owns the subprocess. Parses the NDJSON stream, supports
  cancellation via `SIGINT`, respawns after a hard kill, exposes typed
  `execute()`, and validates interpreter paths.
* **`settings.ts`** — Loader for `pi-python/settings.json` (global +
  project) and the `PI_PYTHON_*` env vars.
* **`index.ts`** — Glue: registers the tools and slash commands, owns the
  single kernel reference, hooks `session_tree` to kill the kernel when
  the conversation moves to another branch, and tears down on
  `session_shutdown`.

Cells inside one `python` call run sequentially; if a cell raises, later
cells are skipped (Jupyter notebook semantics). The trailing expression
of a cell, if any, has its `repr()` shown — same as a notebook cell.

## Interrupt model

The kernel is designed to **survive timeouts**. SIGINT handling is
routed carefully so a runaway cell can be interrupted without taking
down the whole runner:

* At startup the runner installs `SIG_IGN` for `SIGINT`. The main
  loop, `sys.stdin` readline, and between-cell bookkeeping all ignore
  the signal.
* During `_run_cell` only, the runner installs Python's default
  `SIGINT` handler (which raises `KeyboardInterrupt`). On entry to
  the next cell the previous handler is restored unconditionally so
  a buggy cell can't un-protect the runner.
* `kernel.execute()` sends `SIGINT` when `timeoutMs` expires. The cell
  catches it, the runner emits the usual `cell_end` + `done` events,
  and the namespace stays intact. State established by cells that
  completed before the interrupt is preserved in the live kernel, so a
  follow-up call resumes from there.
* If the cell doesn't return within `interruptGraceMs` (default 30s,
  configurable) the kernel is hard-killed as a last resort — this
  catches genuinely wedged cases like a C extension that ignores
  signals.
  Set `interruptGraceMs: 0` to disable the auto-kill entirely (rely on
  `/python-restart` for truly wedged kernels).

**Implication for long-running work**: split big jobs into multiple
cells. State accrued in cells 0..N–1 survives a timeout in cell N,
so a follow-up `python` call can resume from where you left off.

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
  // When auto-resolving the interpreter, walk from `cwd` upward looking
  // for a venv. Stops at the first match, or at a `.git` repo root
  // (never crosses repo boundaries). Default: true.
  "venvParentWalk": true,

  // Directory names checked at each level when auto-resolving the
  // interpreter. A user-provided list FULLY OVERWRITES the default —
  // setting `[".my-env"]` means *only* `.my-env` is searched, the
  // defaults below are not appended. Set to `[]` to disable venv
  // autodiscovery entirely. Default: [".venv", "venv"].
  "venvDirNames": [".venv", "venv"],

  // Upper bound (seconds) the `python` tool's `timeout` parameter is
  // clamped to. Raise this if you have very long-running cells (data
  // pulls, training, large aggregations). Default: 3600 (1 hour).
  "maxTimeoutSeconds": 3600,

  // Grace period (milliseconds) after the timeout SIGINT before the
  // kernel is hard-killed. The runner catches SIGINT and wraps up
  // cleanly; SIGKILL only fires if the cell is genuinely wedged
  // (e.g. a C extension that ignores signals). Set to 0 to disable
  // the auto-kill entirely. Default: 30000.
  "interruptGraceMs": 30000
}
```

Precedence (highest wins): env var → project file → global file →
built-in default.

### Environment variable overrides

| Env var | Setting it overrides |
| ------- | -------------------- |
| `PI_PYTHON_VENV_PARENT_WALK` | `venvParentWalk` (boolean: `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`) |
| `PI_PYTHON_VENV_DIR_NAMES` | `venvDirNames` (comma-separated; an explicitly-empty value disables autodiscovery; leave the env var unset to use the default) |
| `PI_PYTHON_MAX_TIMEOUT_SECONDS` | `maxTimeoutSeconds` (positive integer) |
| `PI_PYTHON_INTERRUPT_GRACE_MS` | `interruptGraceMs` (non-negative integer; 0 disables auto-kill) |
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
files. `npm test` runs the end-to-end interrupt/timeout suite (no mocks;
uses a real `PythonKernel`).

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
* **The namespace dies with the kernel.** `/python-restart`,
  `python_set_interpreter`, a hard kill after an ignored SIGINT, and
  quitting pi all discard it. This is a deliberate trade against the old
  on-disk checkpointing; if you need state to outlive the process, write
  it to a file from inside a cell.

The architecture is borrowed in spirit from
[oh-my-pi's IPython kernel runtime](https://github.com/can1357/oh-my-pi/blob/main/docs/python-repl.md),
with the heavy Jupyter Kernel Gateway replaced by a stdio NDJSON protocol
so this works with a stock Python install. (oh-my-pi's runtime offers an
interactive REPL too; pi-python intentionally does not.)
