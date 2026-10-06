"""WhisperX transcribe worker (sub-project 5A Task 2). Invoked by `PythonMediaEngine` as a short-lived child
process:

    python transcribe.py --job <job.json> --result <result.json> [--dry-run]

Job:    { device, model, compute_type, batch_size, items: [{ source_id, audio_path, language|null }] }
Result: { ok: true, engine: "whisperx:<model>", sources: [{ source_id, language, alignment, segments }] }
      | { ok: false, kind: "contract" | "transient", reason }
Exit code is always 0 -- every failure is reported through the result file, never a traceback on stderr, so
the TS side can tell "this input is unfixable" (`contract`) from "try again" (`transient`) instead of just
"the process died".

`--dry-run` never imports torch/whisperx/omnivoice: it validates the job and writes an empty-segment result
per item, so CI (no GPU, no model weights on this machine) can still exercise the process/JSON contract. Its
result also echoes the split device (see `split_device` below) into the `engine` string, so
`packages/adapters/media-python/test/python-scripts.test.ts` can assert the split happened correctly without
needing a real GPU.
"""

from __future__ import annotations

import argparse
import gc
import os
import sys
from collections import defaultdict
from typing import Any

import engine_io as _io

read_job = _io.read_job
write_result = _io.write_result
log = _io.log


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True)
    p.add_argument("--result", required=True)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(argv)


def split_device(device: str) -> tuple[str, int]:
    """`whisperx.load_model` forwards `device` straight into faster-whisper/ctranslate2, which accepts only
    the bare strings `"cpu"`/`"cuda"` plus a separate `device_index` -- passing it the harness's own
    `"cuda:0"`-style device string raises `ValueError: unsupported device cuda:0`. This is the one place that
    string is split; `whisperx.load_align_model`/`whisperx.align` keep taking the *original* full device
    string unchanged (torch itself accepts `"cuda:0"` fine).

    `"cuda:0"` -> `("cuda", 0)`, `"cuda:1"` -> `("cuda", 1)`, `"cpu"` -> `("cpu", 0)`.
    """
    dev, _sep, idx = str(device).partition(":")
    dev = dev or "cpu"
    index = int(idx) if idx else 0
    return dev, index


def _global_name(obj: Any) -> str:
    """`typing.Any` is a plain object rather than a class on some Python versions, so it carries `_name`
    instead of `__qualname__`; everything else in the allow-list below is a class."""
    return str(getattr(obj, "__qualname__", None) or getattr(obj, "_name", None) or repr(obj))


def allow_vad_checkpoint_globals() -> list[str]:
    """Allow-lists the handful of classes WhisperX's bundled VAD checkpoint pickles, so `load_model` works on
    torch >= 2.6.

    `whisperx.load_model(..., vad_method="pyannote")` (the default) loads `whisperx/assets/pytorch_model.bin`
    -- a file that ships INSIDE the installed whisperx wheel, not something downloaded per run -- through
    `pyannote.audio`'s `Model.from_pretrained` -> lightning `pl_load` -> `torch.load`. PyTorch 2.6 flipped
    `torch.load`'s `weights_only` default to `True`, and that checkpoint pickles six non-tensor objects
    (`omegaconf` config nodes, `TorchVersion`, pyannote's own `Introspection`/`Specifications` and their
    enums), so every real transcribe run died at model load with
    `UnpicklingError: Weights only load failed ... Unsupported global` -- reported to the harness as a
    `transient` failure and retried forever. (Task 11, first real GPU run.)

    Deliberately an allow-list of those exact classes rather than forcing `weights_only=False` back on:
    nothing else in the checkpoint gets to unpickle arbitrary code. Entirely best effort -- a whisperx or
    pyannote version that moved/renamed any of these simply contributes fewer entries (and, if the checkpoint
    still needs them, fails at `load_model` with the same clear message as before), and a torch too old to
    have `add_safe_globals` at all is a no-op. Returns the names actually allow-listed, for the log line and
    for a test to assert against without a GPU.
    """
    try:
        import torch  # noqa: PLC0415  -- deliberately local: this module must import with no torch installed
    except Exception:
        return []

    add = getattr(torch.serialization, "add_safe_globals", None)
    if add is None:
        return []

    # `typing.Any` and `collections.defaultdict` appear as the *type arguments* omegaconf stores alongside its
    # config nodes; builtins are not allow-listed by default either once a pickle names them explicitly.
    allowed: list[Any] = [Any, defaultdict, dict, list, int, float, str, bool]
    for module_name, attrs in (
        ("omegaconf.listconfig", ("ListConfig",)),
        ("omegaconf.dictconfig", ("DictConfig",)),
        ("omegaconf.base", ("ContainerMetadata", "Metadata")),
        ("omegaconf.nodes", ("AnyNode",)),
        ("torch.torch_version", ("TorchVersion",)),
        ("pyannote.audio.core.model", ("Introspection",)),
        ("pyannote.audio.core.task", ("Specifications", "Problem", "Resolution")),
    ):
        try:
            module = __import__(module_name, fromlist=list(attrs))
        except Exception:
            continue
        for attr in attrs:
            obj = getattr(module, attr, None)
            if obj is not None:
                allowed.append(obj)

    # No `if not allowed` guard: `allowed` is seeded with eight builtins above, so it is never empty.
    try:
        add(allowed)
    except Exception:
        return []
    return [f"{getattr(o, '__module__', '?')}.{_global_name(o)}" for o in allowed]


def validate_job(job: dict[str, Any]) -> str | None:
    for key in ("device", "model", "compute_type", "batch_size", "items"):
        if key not in job:
            return f"job missing required field: {key}"
    if not isinstance(job["items"], list):
        return "job.items must be a list"
    for i, item in enumerate(job["items"]):
        for key in ("source_id", "audio_path"):
            if key not in item:
                return f"job.items[{i}] missing required field: {key}"
    return None


def dry_run(job: dict[str, Any], result_path: str) -> None:
    dev, index = split_device(job["device"])
    sources = [
        {"source_id": item["source_id"], "language": item.get("language"), "alignment": "word", "segments": []}
        for item in job["items"]
    ]
    write_result(result_path, {"ok": True, "engine": f"whisperx:{job['model']}(dry-run,device={dev},device_index={index})", "sources": sources})


def _fallback_segments(segments_in: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"start": s.get("start", 0.0), "end": s.get("end", 0.0), "text": s.get("text", ""), "words": []} for s in segments_in]


def run(job: dict[str, Any], result_path: str) -> None:
    device = job["device"]

    try:
        import torch
        import whisperx
    except ImportError as e:
        write_result(result_path, {"ok": False, "kind": "contract", "reason": f"required python package not importable: {e}"})
        return

    if device.startswith("cuda") and not torch.cuda.is_available():
        write_result(result_path, {"ok": False, "kind": "contract", "reason": f"device {device!r} requested but CUDA is not available"})
        return

    dev, device_index = split_device(device)
    log("info", "allow-listed VAD checkpoint globals for torch.load", classes=allow_vad_checkpoint_globals())
    try:
        model = whisperx.load_model(job["model"], dev, device_index=device_index, compute_type=job["compute_type"])
    except Exception as e:  # model load / download / OOM
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"failed to load whisperx model: {e}"})
        return

    # Phase 1: transcribe every item with the whisper model, keeping each item's language/segments/audio for
    # the alignment pass below.
    transcribed: list[dict[str, Any]] = []
    try:
        for item in job["items"]:
            audio_path = item["audio_path"]
            if not os.path.exists(audio_path):
                write_result(result_path, {"ok": False, "kind": "contract", "reason": f"audio_path not found: {audio_path}"})
                return

            audio = whisperx.load_audio(audio_path)
            out = model.transcribe(audio, batch_size=job["batch_size"], language=item.get("language"))
            language = out.get("language") or item.get("language") or "en"
            transcribed.append({"source_id": item["source_id"], "language": language, "segments_in": out.get("segments", []), "audio": audio})
    except MemoryError as e:
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"out of memory: {e}"})
        return
    except RuntimeError as e:
        kind_reason = f"out of memory: {e}" if "out of memory" in str(e).lower() else f"transcribe failed: {e}"
        write_result(result_path, {"ok": False, "kind": "transient", "reason": kind_reason})
        return
    except Exception as e:
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"transcribe failed: {e}"})
        return

    # Free the whisper model before loading any alignment model (same rationale as tts.py freeing the TTS
    # model before its alignment pass): the two rarely fit in VRAM together on a single consumer GPU.
    del model
    gc.collect()
    try:
        torch.cuda.empty_cache()
    except Exception:
        pass

    # Phase 2: align, one alignment model per language, cached for the life of this process -- items commonly
    # share a language, and reloading it per item would be needless GPU churn. Uses the *original* full
    # `device` string (e.g. "cuda:0"), not the split (dev, device_index) pair above -- torch/whisperx accept
    # that form directly.
    align_cache: dict[str, tuple[Any, Any] | None] = {}
    sources: list[dict[str, Any]] = []
    try:
        for entry in transcribed:
            language = entry["language"]
            if language not in align_cache:
                try:
                    align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
                    align_cache[language] = (align_model, metadata)
                except Exception as e:
                    align_cache[language] = None
                    log("warn", "no alignment model for language, falling back to segment-level timing", language=language, reason=str(e))

            cached = align_cache[language]
            segments_in = entry["segments_in"]
            if cached is not None:
                align_model, metadata = cached
                aligned = whisperx.align(segments_in, align_model, metadata, entry["audio"], device, return_char_alignments=False)
                segments = [
                    {
                        "start": s.get("start", 0.0),
                        "end": s.get("end", 0.0),
                        "text": s.get("text", ""),
                        "words": [
                            {"word": w["word"], "start": w["start"], "end": w["end"], **({"score": w["score"]} if "score" in w else {})}
                            for w in s.get("words", [])
                            if "start" in w and "end" in w
                        ],
                    }
                    for s in aligned.get("segments", segments_in)
                ]
                alignment = "word"
            else:
                segments = _fallback_segments(segments_in)
                alignment = "segment"

            sources.append({"source_id": entry["source_id"], "language": language, "alignment": alignment, "segments": segments})
    except MemoryError as e:
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"out of memory: {e}"})
        return
    except RuntimeError as e:
        kind_reason = f"out of memory: {e}" if "out of memory" in str(e).lower() else f"alignment failed: {e}"
        write_result(result_path, {"ok": False, "kind": "transient", "reason": kind_reason})
        return
    except Exception as e:
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"alignment failed: {e}"})
        return

    write_result(result_path, {"ok": True, "engine": f"whisperx:{job['model']}", "sources": sources})


def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        job = read_job(args.job)
    except Exception as e:
        write_result(args.result, {"ok": False, "kind": "contract", "reason": f"could not read job file: {e}"})
        return

    error = validate_job(job)
    if error:
        write_result(args.result, {"ok": False, "kind": "contract", "reason": error})
        return

    if args.dry_run:
        dry_run(job, args.result)
        return

    run(job, args.result)


if __name__ == "__main__":
    main()
