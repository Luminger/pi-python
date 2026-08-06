"""
pi-python runner.

Launched as a long-lived subprocess by the pi-python extension. Reads
NDJSON requests on stdin, executes Python cells in a persistent namespace,
and emits NDJSON events on stdout. User stdout/stderr are intercepted and
forwarded as framed events so the host can stream them to the LLM.

Wire protocol
-------------
Request (host -> runner), one JSON object per line. Multiple request kinds
are supported, distinguished by the optional `type` field (default "execute").

    # type: "execute" (default) — run cells in the persistent namespace
    {
        "id": "<request-id>",
        "type": "execute",
        "cells": [{"code": "...", "title": "optional"}],
        "reset": false,            # optional
        "cwd": "/abs/path"         # optional
    }

Response (runner -> host), one JSON object per line:
    {"id","type":"stdout"|"stderr","cell":N,"data":"..."}
    {"id","type":"cell_end","cell":N,"ok":bool,
        "value":"<repr-or-empty>",
        "exception":"<traceback-or-empty>"}
    {"id","type":"done","cells_run":N,"reset":bool}
    {"id","type":"fatal","error":"..."}            # only on protocol errors

The protocol uses sys.__stdout__ for framing, so user code that writes to
sys.stdout / sys.stderr stays cleanly separated from control messages.
"""

from __future__ import annotations

import ast
import json
import os
import re
import signal

import sys
import time
import traceback
from typing import Any

def _prune_foreign_pythonpath() -> list[str]:
    """Drop ``sys.path`` entries built for a *different* Python version.

    The host process passes its environment to the runner, ``PYTHONPATH``
    included. That is right for a project path like ``src/`` and actively
    harmful for anything version-specific: pi may be running under one
    interpreter (say a nix shell whose ``PYTHONPATH`` lists a hundred
    ``python3.13/site-packages`` directories) while the runner is a different
    one (a ``.venv`` on 3.12, chosen by ``python_set_interpreter``).

    Those entries are *prepended*, so they win. The failure is ugly and blames
    the wrong thing: importing a package with a compiled component picks up the
    foreign pure-Python half and the local ``.so``, and you get

        Exception: Version mismatch: this is the 'cffi' package version 2.0.0,
        located in '/nix/store/...-python3.13-cffi-2.0.0/...'. When we import
        the top-level '_cffi_backend' extension module, we get version 2.1.1,
        located in '.../.venv/lib/python3.12/...'

    which names neither the interpreter mismatch nor ``PYTHONPATH``.

    So: keep every entry that is not version-specific, and drop the ones whose
    embedded ``pythonX.Y`` disagrees with this interpreter. Deliberately narrow
    -- a plain source directory has no version in its path and survives.

    Returns the dropped entries so the caller can report them.
    """
    ours = "%d.%d" % sys.version_info[:2]
    pat = re.compile(r"[/\\]python(\d+\.\d+)[/\\]")
    dropped: list[str] = []
    kept: list[str] = []
    for entry in sys.path:
        found = pat.search(entry or "")
        if found and found.group(1) != ours:
            dropped.append(entry)
        else:
            kept.append(entry)
    if dropped:
        sys.path[:] = kept
        # Also correct the variable itself, so a subprocess spawned from a cell
        # (pytest, uv, a build) does not inherit the same broken path.
        raw = os.environ.get("PYTHONPATH")
        if raw:
            parts = [p for p in raw.split(os.pathsep) if p not in set(dropped)]
            if parts:
                os.environ["PYTHONPATH"] = os.pathsep.join(parts)
            else:
                os.environ.pop("PYTHONPATH", None)
    return dropped

# Always frame on the original stdout, regardless of redirection.
_RAW_STDOUT = sys.__stdout__

# SIGINT semantics. The host sends SIGINT to interrupt a runaway cell,
# but we don't want a stray SIGINT (delivered while the runner is between
# cells or blocked on sys.stdin) to take down the whole subprocess and
# lose the namespace. Strategy: install SIG_IGN at
# startup and only switch to Python's default KeyboardInterrupt-raising
# handler for the duration of a single cell's exec/eval. The previous
# handler is restored in a finally so a buggy cell can't permanently
# uninstall it.
_DEFAULT_INT_HANDLER = signal.default_int_handler


def _emit(obj: dict[str, Any]) -> None:
    _RAW_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _RAW_STDOUT.flush()


class _StreamWriter:
    """File-like object that forwards writes as framed events."""

    def __init__(self, request_id: str, cell_index: int, stream: str) -> None:
        self._id = request_id
        self._cell = cell_index
        self._stream = stream

    def write(self, data: str) -> int:
        if not data:
            return 0
        _emit(
            {
                "id": self._id,
                "type": self._stream,
                "cell": self._cell,
                "data": data,
            }
        )
        return len(data)

    def flush(self) -> None:  # pragma: no cover - nothing buffered
        pass

    def isatty(self) -> bool:
        return False


def _make_namespace() -> dict[str, Any]:
    ns: dict[str, Any] = {
        "__name__": "__pi_python__",
        "__doc__": None,
        "__package__": None,
        "__builtins__": __builtins__,
    }
    return ns


def _run_cell(ns: dict[str, Any], code: str) -> tuple[bool, str, str]:
    """Execute one cell. Returns (ok, value_repr, traceback_str).

    Mirrors Jupyter / IPython notebook semantics: the cell body is parsed as
    a Module, all leading statements are exec()d, and a trailing bare
    expression (if any) is eval()d so its value can be displayed. This is
    why `def f(): ...\nf()` shows `f()`'s return value, but `x = 1` does
    not.

    SIGINT is re-enabled around the user code so the host can interrupt a
    runaway cell. The previous handler (typically SIG_IGN; see main()) is
    restored unconditionally so a buggy cell can't permanently unprotect
    the runner.
    """
    try:
        tree = ast.parse(code, "<pi-python cell>", "exec")
    except SyntaxError:
        return False, "", traceback.format_exc()
    except BaseException:
        return False, "", traceback.format_exc()

    # Split off a trailing top-level expression statement, if present, so we
    # can capture its value. ast.Expr is a *statement* whose .value is the
    # actual expression; bare statements like assignments are not Expr nodes.
    trailing_expr: ast.Expression | None = None
    body = list(tree.body)
    if body and isinstance(body[-1], ast.Expr):
        last = body.pop()
        trailing_expr = ast.Expression(body=last.value)
        ast.copy_location(trailing_expr, last)

    exec_module = ast.Module(body=body, type_ignores=tree.type_ignores)

    try:
        exec_code = compile(exec_module, "<pi-python cell>", "exec")
        eval_code = (
            compile(trailing_expr, "<pi-python cell>", "eval")
            if trailing_expr is not None
            else None
        )
    except BaseException:
        return False, "", traceback.format_exc()

    # Enable KeyboardInterrupt-raising SIGINT *only* around the user code.
    # See module-level comment on _DEFAULT_INT_HANDLER for why.
    prev_sigint = signal.signal(signal.SIGINT, _DEFAULT_INT_HANDLER)
    try:
        exec(exec_code, ns)
        if eval_code is not None:
            value = eval(eval_code, ns)
            value_repr = "" if value is None else repr(value)
        else:
            value_repr = ""
        return True, value_repr, ""
    except SystemExit as exc:
        # Treat SystemExit as a normal failure — do not actually exit the runner.
        return False, "", f"SystemExit: {exc.code!r}\n"
    except KeyboardInterrupt:
        return False, "", "KeyboardInterrupt\n"
    except BaseException:
        return False, "", traceback.format_exc()
    finally:
        # Restore SIG_IGN (or whatever was installed before) so a stray
        # SIGINT delivered after the cell exits — e.g. while we frame the
        # cell_end / done events — can't take down the runner.
        signal.signal(signal.SIGINT, prev_sigint)


def _handle_request(state: dict[str, Any], msg: dict[str, Any]) -> None:
    kind = msg.get("type", "execute")
    if kind != "execute":
        _emit(
            {
                "id": msg.get("id", ""),
                "type": "fatal",
                "error": f"unknown request type: {kind!r}",
            }
        )
        return

    request_id = msg.get("id", "")
    cells = msg.get("cells") or []
    reset = bool(msg.get("reset"))
    cwd = msg.get("cwd")

    if reset:
        state["ns"] = _make_namespace()

    if cwd and isinstance(cwd, str) and os.path.isdir(cwd):
        try:
            os.chdir(cwd)
            if cwd not in sys.path:
                sys.path.insert(0, cwd)
        except OSError as exc:
            _emit(
                {
                    "id": request_id,
                    "type": "stderr",
                    "cell": -1,
                    "data": f"[pi-python] failed to chdir to {cwd!r}: {exc}\n",
                }
            )

    ns = state["ns"]
    cells_run = 0

    for index, cell in enumerate(cells):
        code = (cell or {}).get("code", "")
        if not isinstance(code, str):
            _emit(
                {
                    "id": request_id,
                    "type": "cell_end",
                    "cell": index,
                    "ok": False,
                    "value": "",
                    "exception": "[pi-python] cell.code must be a string\n",
                }
            )
            break

        # Redirect user stdout/stderr to framed writers for this cell only.
        prev_out, prev_err = sys.stdout, sys.stderr
        sys.stdout = _StreamWriter(request_id, index, "stdout")
        sys.stderr = _StreamWriter(request_id, index, "stderr")
        try:
            ok, value_repr, exc_text = _run_cell(ns, code)
        finally:
            sys.stdout = prev_out
            sys.stderr = prev_err

        cells_run += 1
        _emit(
            {
                "id": request_id,
                "type": "cell_end",
                "cell": index,
                "ok": ok,
                "value": value_repr,
                "exception": exc_text,
            }
        )

        if not ok:
            # Stop running further cells in this request — caller can decide
            # whether to retry; matches Jupyter notebook semantics.
            break

    _emit(
        {
            "id": request_id,
            "type": "done",
            "cells_run": cells_run,
            "reset": reset,
        }
    )


def main() -> int:
    # Before anything else imports: a PYTHONPATH inherited from a host running
    # a different interpreter would otherwise shadow this one's packages.
    pruned = _prune_foreign_pythonpath()

    state: dict[str, Any] = {"ns": _make_namespace()}

    # SIGINT is the host's interrupt signal. Default for the runner is to
    # ignore it; _run_cell re-enables it just around user code. This keeps
    # the runner alive across interrupts of buggy cells, so the namespace
    # (and any state the cell did manage to populate) survives.
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    # Announce ourselves once so the host can confirm the protocol version.
    _emit(
        {
            "type": "ready",
            "python": sys.version,
            "executable": sys.executable,
            "cwd": os.getcwd(),
            "pid": os.getpid(),
            "protocol": 2,
            # Surfaced rather than silent: if an import later resolves somewhere
            # unexpected, the first question is what was removed from the path.
            "pruned_path_entries": len(pruned),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"type": "fatal", "error": f"invalid JSON: {exc}"})
            continue

        if not isinstance(msg, dict):
            _emit({"type": "fatal", "error": "request must be a JSON object"})
            continue

        try:
            _handle_request(state, msg)
        except BaseException:
            _emit(
                {
                    "id": msg.get("id", ""),
                    "type": "fatal",
                    "error": traceback.format_exc(),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
