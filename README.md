# pi-python

A pi extension that gives the agent a persistent Python execution environment,
plus an interactive Python REPL the user can drop into mid-conversation that
shares the same kernel.

Spawns one long-lived `python3 -u` subprocess per pi session, lazily on first
use. State is checkpointed to disk after every successful cell so kernel
restarts (and `/tree` navigation) preserve variables, imports, and definitions.

## Tools the agent sees

| Tool | What it does |
| ---- | ------------ |
| `python` | Run one or more Python cells in the persistent kernel. Variables, imports, and definitions persist across calls and across kernel restarts (via on-disk checkpoints). Default timeout 120s, max 600s. |
| `python_set_interpreter` | Switch the kernel to a different python interpreter binary (e.g. `/path/to/.venv/bin/python` or `python3.12`). Kills the current kernel and spawns a new one. The namespace is wiped — checkpoints are **not** restored across an interpreter switch because pickled objects from one venv typically can't load into another. |

Both tools are registered with `executionMode: "sequential"` so the agent
never tries to run two cells (or a cell and an interpreter switch)
concurrently against the same kernel.

There is intentionally **no** `python_reset` tool. If the agent needs a clean
namespace it can call `python_set_interpreter` with the same path (which
discards state by design), run `globals().clear()` in a cell, or ask the user
to `/python-restart`.

## Slash commands the user sees

| Command | What it does |
| ------- | ------------ |
| `/python-status` | Kernel info (executable, pid, pickler) + checkpoint stats (count, total size, latest, branch coverage) + active settings with their source. |
| `/python-restart` | Kill and respawn the kernel — interrupts a hung cell — then automatically restore the latest on-disk checkpoint for the current branch leaf. State up through the last successful cell is preserved. |
| `/python-repl` | Drop into an interactive Python shell that drives the **same** kernel the agent uses. Multi-line input via `... ` continuation (using `codeop.compile_command`, the same primitive Python's own REPL uses), `↑`/`↓` history, `Ctrl+C` interrupt, `Esc` / `Ctrl+D` / `:q` to exit. Variables you define are visible to the agent on its next `python` call (and vice versa). |

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
│  kernel.ts   │     stream events      │  (persistent ns) │
│  repl.ts     │                        └──────────────────┘
│  settings.ts │
└──────────────┘
       │
       └─── ~/.pi/pi-python/<sessionId>/<leafId>.pkl
              checkpoints, keyed by session tree leaf
```

* **`runner.py`** — Python subprocess that reads NDJSON requests on stdin
  (`execute`, `compile_check`, `checkpoint`, `restore`) and emits framed
  events on stdout. User code that prints is captured by replacing
  `sys.stdout` / `sys.stderr` with stream writers; control messages always
  go through `sys.__stdout__`.
* **`kernel.ts`** — Owns the subprocess. Parses the NDJSON stream, supports
  cancellation via `SIGINT`, respawns after a hard kill, exposes typed
  `execute()` / `checkSyntax()` / `checkpoint()` / `restore()` methods, and
  validates interpreter paths.
* **`repl.ts`** — `ctx.ui.custom()` TUI component: scrollback + single-line
  `Input` prompt + `... ` continuation driven by `compile_check` calls.
* **`settings.ts`** — Loader for `pi-python/settings.json` (global + project)
  and the `PI_PYTHON_*` env vars.
* **`index.ts`** — Glue: registers the tools and slash commands, owns the
  single kernel reference, hooks `message_end` for auto-checkpoint, hooks
  `session_tree` to kill the kernel for branch-restore, and tears down on
  `session_shutdown`.

Cells inside one `python` call run sequentially; if a cell raises, later
cells are skipped (Jupyter notebook semantics). The trailing expression of a
cell, if any, has its `repr()` shown — same as a notebook cell.

## Checkpoints

After every successful `python` tool call, the runner pickles the kernel
namespace and writes it to:

```
~/.pi/pi-python/<sessionId>/<leafId>.pkl
```

`<leafId>` is the id of the toolResult message in pi's session tree, so the
checkpoint is naturally branch-bound: pi's `/fork`, `/clone`, and `/tree`
navigation all just change which leaf is "current", and the right pickle gets
restored on the next kernel spawn.

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
  run `/python-restart` (or wait for the next spawn) to pick it up. The
  REPL shares the kernel with the agent's `python` tool, so both see the
  same pickler.
* **Per-key best-effort** — values that can't be pickled (open file handles,
  most ML model objects, lambdas without dill) are skipped individually
  rather than failing the whole checkpoint. Skipped names appear in
  `/python-status`.
* **Size cap** — pickles bigger than `pickleMaxBytes` (default 256 MB) are
  written to nothing and the leaf is marked "skipped" for the session so we
  don't keep retrying. Surface in `/python-status`.
* **Eviction** — at most 20 checkpoints per session are kept on disk; older
  off-branch checkpoints are evicted first. Active-branch checkpoints are
  never evicted.
* **Restore is automatic** on the next kernel spawn (cold start,
  `/python-restart`, post-`/tree` navigation). Failures are silent (you keep
  going with an empty namespace) but recorded — see `/python-status`.
* **Switching interpreters discards state**: `python_set_interpreter` does
  not restore from a checkpoint, since cross-interpreter pickle loads
  typically fail.

## Settings

`pi-python` reads its own JSON settings file from two locations, mirroring
pi's own settings.json layout:

```
~/.pi/pi-python/settings.json          (global)
<cwd>/.pi/pi-python/settings.json      (project, overrides global)
```

Both files are optional; missing fields fall back to the lower-precedence
source. Schema:

```jsonc
{
  // Max bytes for an automatic checkpoint pickle. Larger pickles are
  // skipped (and the leaf is marked so we don't retry). Default: 256 MB.
  "pickleMaxBytes": 268435456
}
```

Precedence (highest wins): env var → project file → global file → built-in
default.

### Environment variable overrides

| Env var | Setting it overrides |
| ------- | -------------------- |
| `PI_PYTHON_PICKLE_MAX_BYTES` | `pickleMaxBytes` (positive integer, in bytes) |
| `PI_PYTHON` | Default interpreter (same role as `--python`, lower precedence than the flag and `python_set_interpreter`) |

## Interpreter resolution

In order of priority:

1. `python_set_interpreter` (if the agent has switched mid-session)
2. `--python <path>` CLI flag
3. `$PI_PYTHON` env var
4. `$VIRTUAL_ENV/bin/python`
5. `<cwd>/.venv/bin/python`, `<cwd>/venv/bin/python`
6. `python3` on `PATH`

`python_set_interpreter` and the `--python` flag both accept either an
absolute path to a binary or a bare command name on `PATH`. Directories are
rejected with a hint pointing at the binary path inside.

API-key-shaped env vars (`OPENAI_*`, `ANTHROPIC_*`, `*_API_KEY`, `*_TOKEN`,
`*_SECRET`, etc.) are stripped from the subprocess env so LLM-generated code
that reads `os.environ` can't exfiltrate them.

## Install

The repo doubles as the extension package, so `npm install` here pulls in
the typings and dev tooling, and `npm run check` typechecks all four TS
files:

```bash
npm install
npm run check
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

Then `/reload` inside pi (or restart). `/python-status` will confirm it's
loaded. The `--python <path>` flag in `pi --help` is also a quick check —
it's registered by this extension, so its presence means pi-python loaded.

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
new pid. Throws (with the validation error) if the path doesn't point at a
runnable interpreter.

## Known limitations

* **No rich display** — only text stdout/stderr and `repr()` of trailing
  expressions. No `image/png` / `text/markdown` envelopes (yet).
* **`input()` is not supported** — there is no interactive stdin. Pass data
  through variables instead.
* **`subprocess` output via raw fd 1** — `subprocess.run(...,
  capture_output=True)` works, but child processes that write directly to
  fd 1 bypass our `sys.stdout` shadowing.
* **One kernel per pi process** — no shared gateway across multiple pi
  instances. If you need that, the next step is binding the kernel to a
  Unix socket per session file.
* **REPL submissions aren't tree-bound yet** — cells you run via
  `/python-repl` execute against the kernel but aren't persisted as
  session entries, so they don't appear in `/python-repl` scrollback the
  next time you open it and they don't trigger their own checkpoints. The
  next `python` tool call's checkpoint will still capture any state you
  left behind. Fixing this is the planned next iteration.
* **Forked sessions don't inherit parent checkpoints.** A `/fork` starts
  with a fresh kernel; the parent's pickles aren't pulled forward.
* **Orphaned checkpoint dirs.** When a pi session is deleted, its
  `~/.pi/pi-python/<sessionId>/` dir stays behind. No automatic cleanup
  yet.

The architecture is borrowed in spirit from
[oh-my-pi's IPython kernel runtime](https://github.com/can1357/oh-my-pi/blob/main/docs/python-repl.md),
with the heavy Jupyter Kernel Gateway replaced by a stdio NDJSON protocol
so this works with a stock Python install.
