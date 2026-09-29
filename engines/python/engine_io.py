"""Shared IO helpers for the sub-project 5A media engine scripts (transcribe.py, tts.py).

Job/result protocol (spec sub-project 5A Task 2): the TypeScript `PythonMediaEngine` writes a job JSON file,
spawns `python <script> --job <job.json> --result <result.json> [--dry-run]`, and reads back the result JSON
file this module's `write_result` wrote. Every log line goes to stderr as one JSON object per line (`log`) so
the TS side can forward each line to its own logger without guessing at a text format; stdout is never used
for anything here (results travel through the result file, not a pipe).

NOTE ON THE NAME: this file is *not* called `_io.py`, even though it started out that way, because CPython
already registers a real *built-in* module under the exact name `_io` (the `io` module's own C
implementation) in `sys.modules` before any user script runs -- a plain `import _io` from `transcribe.py`/
`tts.py` would silently bind that built-in instead of this file, and every call below would raise
`AttributeError`. `transcribe.py`/`tts.py` import this module as `import engine_io` -- a plain import works
because `python <script>` puts the script's own directory (this one) at `sys.path[0]`.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from typing import Any


def _reconfigure_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except Exception:
                pass


_reconfigure_utf8()


def read_job(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_result(path: str, data: dict[str, Any]) -> None:
    """Atomic write: a caller polling for `path` must never observe a partially-written file. Writes to a
    sibling temp file in the same directory (guaranteed same filesystem, so `os.replace` is atomic) and
    renames it into place last.

    `allow_nan=False` because a bare `NaN`/`Infinity` token is valid to `json.dump` but is NOT valid JSON --
    `JSON.parse` on the TypeScript side throws on it. WhisperX alignment is a known source of NaN scores, so
    rather than let that raise all the way up to an unhandled traceback (which the TS side would then have to
    guess at from a non-zero exit code and a stderr tail), a `ValueError` here is caught and turned into a
    clean `transient` result instead -- the recursive call below can never hit this same branch again, since
    that fallback payload is plain strings.
    """
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".engine-result-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, allow_nan=False)
        os.replace(tmp_path, path)
    except ValueError:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        write_result(path, {"ok": False, "kind": "transient", "reason": "non-finite number (NaN/Infinity) in engine result"})
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def log(level: str, msg: str, **data: Any) -> None:
    """One JSON object per line on stderr; `PythonMediaEngine.run()` forwards each such line to the caller's
    `log` callback verbatim."""
    line = {"level": level, "msg": msg, "ts": time.time(), **data}
    print(json.dumps(line, default=str), file=sys.stderr, flush=True)
