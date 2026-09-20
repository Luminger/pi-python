# pi-python

[![npm version](https://img.shields.io/npm/v/pi-python?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-python)
[![npm downloads](https://img.shields.io/npm/dm/pi-python?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-python)
[![CI](https://github.com/Luminger/pi-python/actions/workflows/ci.yml/badge.svg)](https://github.com/Luminger/pi-python/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-python)](LICENSE)

**An IPython-style Python session, made available as a tool to the
[pi](https://github.com/earendil-works/pi) coding agent.**

pi-python gives the agent a notebook-style Python session instead of a sequence
of isolated `python -c` invocations. The agent submits cells to one long-lived
interpreter, sees streaming stdout and stderr plus the value of the final
expression, and keeps the resulting namespace for the next call. Imports,
variables, functions, classes, and live Python objects remain in memory while the
pi session continues.

The interaction model is deliberately familiar: execute cells, inspect results,
refine the code, and continue from the current state. The difference is that the
agent operates the session through a tool rather than a human typing into an
IPython prompt or notebook UI. IPython itself is not a dependency; the runner
implements the relevant cell semantics on top of stock Python.

```bash
pi install npm:pi-python
```

That is the only required step. The runner uses the Python standard library and
works with Python 3.9 or newer. The TypeScript side supports Node 22.19 or newer,
matching pi itself, and Bun 1.3 or newer.

> [!WARNING]
> **This gives the active LLM arbitrary Python execution as your user.** The
> model writes and invokes cells without per-cell approval and can do anything
> that user can do. See [Security](#security).

## Persistence model

One pi session owns one Python process and one namespace.

| Event | Namespace survives? |
| --- | --- |
| Another cell in the same `python` call | **Yes** |
| A later `python` call | **Yes** |
| An ordinary Python exception | **Yes** — mutations made before the exception remain |
| A timeout that reaches Python as `KeyboardInterrupt` | **Yes** |
| `/tree` navigation | **Yes** |
| `reset: true` on a `python` call | No |
| `/python-restart` | No |
| `python_set_interpreter` | No |
| Native crash or hard kill after ignored SIGINT | No |
| Quitting pi | No |

A failed cell is not a transaction: Python keeps assignments and mutations made
before it raised. Later cells in the same call are skipped, but the next tool
call can inspect or continue from the state that remains.

## What it provides

- **Notebook-style cells** — cells run in order and the `repr()` of a trailing
  expression is displayed. A failing cell stops the cells after it.
- **Live output** — stdout and stderr stream back while code runs.
- **Project-aware Python selection** — discovers `.venv` and `venv`, including
  venvs at a uv-workspace or repository root.
- **Runtime interpreter switching** — the agent can move to another Python
  binary when a task needs packages from a different environment.
- **Cooperative interruption** — timeouts send SIGINT first, preserving the
  process and namespace when Python can raise `KeyboardInterrupt`.
- **Useful failure output** — if a genuinely wedged process must be killed, all
  output captured before the kill is still returned.

## Using it

### Agent tools

| Tool | Purpose |
| --- | --- |
| `python` | Run one or more cells in the persistent interpreter. Supports per-call timeout, namespace reset, and working-directory selection. |
| `python_set_interpreter` | Replace the kernel with one using a specific Python executable. This intentionally starts with an empty namespace. |

Two Python calls cannot run concurrently against one interpreter, so both tools
are serialized automatically.

### User commands

| Command | Purpose |
| --- | --- |
| `/python-status` | Show the executable, Python version, process ID, cwd, liveness, and active settings with their sources. |
| `/python-restart` | Kill and respawn the kernel with an empty namespace. Useful for a wedged process or an intentionally clean start. |

Start pi with an explicit interpreter when needed:

```bash
pi --python /path/to/.venv/bin/python
pi --python python3.12
```

The flag is validated at startup. A bad path is reported and normal interpreter
resolution is used instead.

## Interpreter selection

Unless explicitly overridden, pi-python selects an interpreter in this order:

1. The most recent `python_set_interpreter` selection
2. `--python <path>`
3. `$PI_PYTHON`
4. `$VIRTUAL_ENV/bin/python`
5. `.venv` or `venv` in the working directory or one of its parents, stopping
   after checking the repository root
6. `python3` on `PATH`

This makes the common case automatic: start pi anywhere inside a repository and
its project venv is used. Both explicit selection mechanisms accept an absolute
or relative path to an executable, or a bare command name resolvable on `PATH`.
Directories are rejected with a hint pointing at the interpreter inside.

## Timeouts and hard kills

The default tool-call timeout is 120 seconds. The default ceiling is one hour,
and `maxTimeoutSeconds` can raise it for training, large data pulls, or expensive
analysis.

When a timeout expires:

1. The host sends SIGINT. During cell execution, the runner maps it to
   `KeyboardInterrupt`; outside a cell, SIGINT is ignored so bookkeeping cannot
   accidentally kill the process.
2. If the cell has not returned halfway through `interruptGraceMs`, a second
   SIGINT is sent. This catches Python loops or libraries that swallowed the
   first one.
3. At the end of the grace period, the process is hard-killed as a last resort.
   This is necessary for native extensions and blocking system calls that never
   return control to Python.

A cooperative timeout keeps the namespace. A hard kill cannot, but the result is
marked `killed` and includes every byte printed before termination. Set
`interruptGraceMs` to `0` to disable automatic hard kills and rely on
`/python-restart` for wedged kernels.

On Windows, Node cannot deliver a catchable SIGINT to a child process. A timeout
therefore hard-kills the kernel immediately, preserving partial output but not
the namespace.

For long work, use multiple cells: completed setup cells remain available if a
later cell times out.

## Configuration

Optional settings are read from:

```text
${PI_CODING_AGENT_DIR}/pi-python/settings.json       # global
<cwd>/${CONFIG_DIR_NAME}/pi-python/settings.json     # project, overrides global
```

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`; `CONFIG_DIR_NAME` defaults to
`.pi`. On upgrade, an existing `~/.pi/pi-python/settings.json` is moved to the
new global location when that location does not already exist. Migration failure
is non-fatal: the old file remains effective and `/python-status` reports a
warning.

Environment variables override project settings, which override global settings,
which override built-in defaults.

```jsonc
{
  // Search parent directories for a venv, stopping at the repo root.
  "venvParentWalk": true,

  // Full replacement for the default [".venv", "venv"].
  // Use [] to disable venv directory discovery.
  "venvDirNames": [".venv", "venv"],

  // Maximum timeout the agent may request, in seconds.
  "maxTimeoutSeconds": 3600,

  // Delay between timeout SIGINT and the final hard kill, in milliseconds.
  // Use 0 to disable automatic hard kills.
  "interruptGraceMs": 30000
}
```

| Environment variable | Setting |
| --- | --- |
| `PI_PYTHON` | Default interpreter; below the CLI flag and runtime tool selection in precedence |
| `PI_PYTHON_VENV_PARENT_WALK` | `venvParentWalk`; accepts `true`/`false`, `1`/`0`, `yes`/`no`, or `on`/`off` |
| `PI_PYTHON_VENV_DIR_NAMES` | `venvDirNames` as a comma-separated list; an explicitly empty value disables discovery |
| `PI_PYTHON_MAX_TIMEOUT_SECONDS` | `maxTimeoutSeconds` as a positive integer |
| `PI_PYTHON_INTERRUPT_GRACE_MS` | `interruptGraceMs` as a non-negative integer |

`/python-status` reports the effective value and source of every setting, plus
warnings for malformed configuration.

## Security

Installing pi-python delegates arbitrary Python execution to the active LLM.
The model supplies and invokes the code without per-cell approval. There is no
sandbox, and the Python process runs as your user with pi's environment. In
short: the model can do anything that user can do.

If that authority is too broad, isolate pi at the OS level. See
[SECURITY.md](SECURITY.md) for the threat model and reporting policy.

## How it works

```text
┌──────────────┐   NDJSON over stdio   ┌──────────────────┐
│  pi (host)   │  ──────────────────▶  │  python3 runner  │
│  index.ts    │  ◀──────────────────  │  runner.py       │
│  kernel.ts   │     stream events     │  persistent ns   │
│  settings.ts │                       └──────────────────┘
└──────────────┘
```

- **`runner.py`** executes cells in the persistent namespace and emits framed
  stdout, stderr, cell results, and completion events. Control messages always
  use the original `sys.__stdout__`, so normal Python output cannot be confused
  with protocol traffic.
- **`kernel.ts`** owns the subprocess, parses the event stream, handles timeout
  escalation, preserves partial output on hard kills, and respawns dead kernels.
- **`settings.ts`** resolves global, project, and environment configuration.
- **`index.ts`** registers the tools, slash commands, CLI flag, rendering, and
  session lifecycle hooks.

The protocol deliberately needs only a stock Python interpreter — no IPython,
Jupyter server, or kernel gateway. The architecture is inspired by
[oh-my-pi's IPython runtime](https://github.com/can1357/oh-my-pi/blob/main/docs/python-repl.md),
with the gateway replaced by a small stdio protocol.

## Known limitations

- **Text output only** — stdout, stderr, and `repr()` of a trailing expression.
  There are no rich `image/png` or `text/markdown` display envelopes.
- **No interactive stdin** — `input()` is unsupported. Pass data through code,
  variables, files, or tool parameters instead.
- **Raw file-descriptor output bypasses capture** — child processes writing
  directly to fd 1 are not intercepted by the `sys.stdout` wrapper.
  `subprocess.run(..., capture_output=True)` works normally.
- **One kernel per pi process** — kernels are not shared between separate pi
  instances.
- **The namespace is process-local** — quitting, restarting, switching
  interpreters, native crashes, and hard kills discard it. Persist important
  results explicitly when they must outlive the session.
- **`/tree` does not rewind Python** — conversation history can move to another
  branch while the interpreter retains everything executed before the move. Use
  `/python-restart` when you want the process to match the visible transcript.

<details>
<summary>Why the namespace is not checkpointed to disk</summary>

An earlier version pickled the whole namespace after every call so restarts and
`/tree` navigation could restore it. The snapshots required a full serialization
on every call and grew to 80 GB across 421 sessions. Block-level analysis found
only 8% deduplication potential, so the growth was structural rather than a
compression problem. Restores were rarely useful, and many Python objects cannot
be safely serialized in the first place. Re-running setup cells is cheaper and
more predictable.

</details>

## Development

```bash
git clone git@github.com:Luminger/pi-python.git
cd pi-python
npm install
npm run check
npm test          # Node host
npm run test:bun  # Bun host
```

The test suite drives real Python subprocesses and real signals; it does not mock
the behavior it is meant to verify.

Run the checkout directly for one session:

```bash
pi -e ./index.ts
```

Or install the checkout as a local pi package:

```bash
pi install .
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions, branch protection,
and the release process. See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT — see [LICENSE](LICENSE).
