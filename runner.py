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

    # type: "checkpoint" — pickle the current namespace to `path`.
    # Writes are skipped (with reason) when the resulting blob would exceed
    # `max_bytes` (default 256 MB). Best-effort per-key: unpicklable values
    # are skipped without failing the whole checkpoint.
    {"id": "...", "type": "checkpoint", "path": "...", "max_bytes": 268435456}

    # type: "restore" — unpickle from `path` and merge into the namespace.
    # Per-key best-effort on the unpickle side too.
    {"id": "...", "type": "restore", "path": "..."}

Response (runner -> host), one JSON object per line:
    {"id","type":"stdout"|"stderr","cell":N,"data":"..."}
    {"id","type":"cell_end","cell":N,"ok":bool,
        "value":"<repr-or-empty>",
        "exception":"<traceback-or-empty>"}
    {"id","type":"done","cells_run":N,"reset":bool}
    {"id","type":"checkpoint_result",
import signal
        "ok":bool,
        "skipped":bool, "reason":"<text>",
        "bytes":N, "duration_ms":N,
        "keys_picked":N, "keys_skipped":N,
        "skipped_names":[...]}
    {"id","type":"restore_result",
        "ok":bool, "error":"<text>",
        "keys_restored":N, "keys_failed":N,
        "failed_names":[...], "duration_ms":N}
    {"id","type":"fatal","error":"..."}            # only on protocol errors

The protocol uses sys.__stdout__ for framing, so user code that writes to
sys.stdout / sys.stderr stays cleanly separated from control messages.
"""

from __future__ import annotations

import ast
import json
import os
import sys
import time
import traceback
from typing import Any

# Always frame on the original stdout, regardless of redirection.
_RAW_STDOUT = sys.__stdout__

# Pick the best available serializer once at startup. dill handles
# interactively-defined functions, classes, lambdas, and closures — the
# common case in a notebook-style cell loop. Fall back to stdlib pickle if
# dill isn't present so the runner stays usable on a bare interpreter.
try:
    import dill as _pickler  # type: ignore[import-not-found]

    _PICKLER_NAME = "dill"
except ImportError:
    import pickle as _pickler  # type: ignore[no-redef]

    _PICKLER_NAME = "pickle"

# Skip these standard module dunders when checkpointing — they don't make
# sense to round-trip and several of them aren't picklable anyway.
_DUNDER_SKIP = {
    "__name__",
    "__doc__",
    "__package__",
    "__builtins__",
    "__loader__",
    "__spec__",
    "__file__",
    "__cached__",
}


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
    # Enable KeyboardInterrupt-raising SIGINT *only* around the user code.
    # See module-level comment on _DEFAULT_INT_HANDLER for why.
    prev_sigint = signal.signal(signal.SIGINT, _DEFAULT_INT_HANDLER)
    not.
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


def _handle_request(state: dict[str, Any], msg: dict[str, Any]) -> None:
    kind = msg.get("type", "execute")
    if kind == "checkpoint":
        _handle_checkpoint(state, msg)
        return
    if kind == "restore":
        _handle_restore(state, msg)
        return
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
    # SIGINT is the host's interrupt signal. Default for the runner is to
    # ignore it; _run_cell re-enables it just around user code. This keeps
    # the runner alive across interrupts of buggy cells, so the namespace
    # (and any state the cell did manage to populate) survives.
    signal.signal(signal.SIGINT, signal.SIG_IGN)

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


def _handle_checkpoint(state: dict[str, Any], msg: dict[str, Any]) -> None:
    request_id = msg.get("id", "")
    path = msg.get("path", "")
    max_bytes = int(msg.get("max_bytes") or 256 * 1024 * 1024)
    if not isinstance(path, str) or not path:
        _emit(
            {
                "id": request_id,
                "type": "checkpoint_result",
                "ok": False,
                "skipped": True,
                "reason": "path missing",
                "bytes": 0,
                "duration_ms": 0,
                "keys_picked": 0,
                "keys_skipped": 0,
                "skipped_names": [],
            }
        )
        return

    started = time.monotonic()
    ns = state["ns"]
    safe: dict[str, Any] = {}
    skipped_names: list[str] = []

    # Per-key best-effort: try to pickle each value individually. Unpicklable
    # values are skipped so one bad object doesn't blow away an otherwise
    # restorable namespace. Names starting with `_` are skipped on the
    # assumption they're internal/private; users wanting to preserve them can
    # export them explicitly.
    for key, value in list(ns.items()):
        if key in _DUNDER_SKIP or key.startswith("_"):
            continue
        try:
            _pickler.dumps(value)
        except BaseException:
            skipped_names.append(key)
            continue
        safe[key] = value

    # Serialize the filtered dict in one shot. Doing per-key dumps above just
    # to detect picklability is cheaper than detecting failure at write time.
    try:
        blob = _pickler.dumps(safe)
    except BaseException as exc:
        _emit(
            {
                "id": request_id,
                "type": "checkpoint_result",
                "ok": False,
                "skipped": True,
                "reason": f"serialize failed: {type(exc).__name__}: {exc}",
                "bytes": 0,
                "duration_ms": int((time.monotonic() - started) * 1000),
                "keys_picked": 0,
                "keys_skipped": len(skipped_names),
                "skipped_names": skipped_names,
            }
        )
        return

    if len(blob) > max_bytes:
        _emit(
            {
                "id": request_id,
                "type": "checkpoint_result",
                "ok": False,
                "skipped": True,
                "reason": (
                    f"pickle size {len(blob)} bytes exceeds limit {max_bytes}"
                ),
                "bytes": len(blob),
                "duration_ms": int((time.monotonic() - started) * 1000),
                "keys_picked": len(safe),
                "keys_skipped": len(skipped_names),
                "skipped_names": skipped_names,
            }
        )
        return

    # Atomic write so a crashed pi process doesn't leave a half-written file
    # that future restores would choke on.
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "wb") as fh:
            fh.write(blob)
        os.replace(tmp, path)
    except OSError as exc:
        _emit(
            {
                "id": request_id,
                "type": "checkpoint_result",
                "ok": False,
                "skipped": True,
                "reason": f"write failed: {exc}",
                "bytes": len(blob),
                "duration_ms": int((time.monotonic() - started) * 1000),
                "keys_picked": len(safe),
                "keys_skipped": len(skipped_names),
                "skipped_names": skipped_names,
            }
        )
        return

    _emit(
        {
            "id": request_id,
            "type": "checkpoint_result",
            "ok": True,
            "skipped": False,
            "reason": "",
            "bytes": len(blob),
            "duration_ms": int((time.monotonic() - started) * 1000),
            "keys_picked": len(safe),
            "keys_skipped": len(skipped_names),
            "skipped_names": skipped_names,
        }
    )


def _handle_restore(state: dict[str, Any], msg: dict[str, Any]) -> None:
    request_id = msg.get("id", "")
    path = msg.get("path", "")
    if not isinstance(path, str) or not path:
        _emit(
            {
                "id": request_id,
                "type": "restore_result",
                "ok": False,
                "error": "path missing",
                "keys_restored": 0,
                "keys_failed": 0,
                "failed_names": [],
                "duration_ms": 0,
            }
        )
        return

    started = time.monotonic()
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
        loaded = _pickler.loads(blob)
    except FileNotFoundError:
        _emit(
            {
                "id": request_id,
                "type": "restore_result",
                "ok": False,
                "error": f"checkpoint not found: {path}",
                "keys_restored": 0,
                "keys_failed": 0,
                "failed_names": [],
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        )
        return
    except BaseException as exc:
        _emit(
            {
                "id": request_id,
                "type": "restore_result",
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "keys_restored": 0,
                "keys_failed": 0,
                "failed_names": [],
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        )
        return

    if not isinstance(loaded, dict):
        _emit(
            {
                "id": request_id,
                "type": "restore_result",
                "ok": False,
                "error": f"expected dict, got {type(loaded).__name__}",
                "keys_restored": 0,
                "keys_failed": 0,
                "failed_names": [],
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        )
        return

    ns = state["ns"]
    failed: list[str] = []
    restored = 0
    for key, value in loaded.items():
        if not isinstance(key, str):
            continue
        if key in _DUNDER_SKIP:
            continue
        try:
            ns[key] = value
            restored += 1
        except BaseException:
            failed.append(key)

    _emit(
        {
            "id": request_id,
            "type": "restore_result",
            "ok": True,
            "error": "",
            "keys_restored": restored,
            "keys_failed": len(failed),
            "failed_names": failed,
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
    )


def main() -> int:
    state: dict[str, Any] = {"ns": _make_namespace()}

    # Announce ourselves once so the host can confirm the protocol version.
    _emit(
        {
            "type": "ready",
            "python": sys.version,
            "executable": sys.executable,
            "cwd": os.getcwd(),
            "pid": os.getpid(),
            "protocol": 1,
            "pickler": _PICKLER_NAME,
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
