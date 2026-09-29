"""OmniVoice TTS + WhisperX alignment worker (sub-project 5A Task 2). Invoked by `PythonMediaEngine` as a
short-lived child process:

    python tts.py --job <job.json> --result <result.json> [--dry-run]

Job:    { device, model, dtype, num_step, speed, language, ref_audio, ref_text, align,
          lines: [{ line_id, chunks: [string], out_path, pause_seconds }] }
Result: { ok: true, lines: [{ line_id, wav_path, duration_seconds, chunks: [{text,start,end}],
          words: [...] | null, alignment }] }
      | { ok: false, kind: "contract" | "transient", reason }
Exit code is always 0, same contract as `transcribe.py`.

`--dry-run` never imports torch/omnivoice/whisperx: it validates the job and writes a 0.1s silent wav per
line (via the stdlib `wave` module) with chunk spans proportional to each chunk's character count, so CI (no
GPU, no model weights) can still exercise the process/JSON contract end to end.
"""

from __future__ import annotations

import argparse
import os
import sys
import wave
from typing import Any

import engine_io as _io

read_job = _io.read_job
write_result = _io.write_result
log = _io.log

SAMPLE_RATE = 24000
DRY_RUN_SECONDS = 0.1
MAX_CHUNK_ATTEMPTS = 3  # first try + "đọc lại tối đa 2 lần" (retry at most twice)
# `torch.<dtype>` must resolve to a real dtype attribute; an unsupported value is a config mistake the
# operator made (typo'd dtype in project.yaml), not something a retry could ever fix -- checked in
# validate_job() so it fails `contract`, not a retried `transient` from a bare AttributeError.
SUPPORTED_DTYPES = {"float16", "bfloat16", "float32"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True)
    p.add_argument("--result", required=True)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(argv)


def validate_job(job: dict[str, Any]) -> str | None:
    for key in ("device", "model", "dtype", "num_step", "speed", "language", "ref_audio", "ref_text", "align", "lines"):
        if key not in job:
            return f"job missing required field: {key}"
    if job["dtype"] not in SUPPORTED_DTYPES:
        return f"job.dtype must be one of {sorted(SUPPORTED_DTYPES)}, got: {job['dtype']!r}"
    if not isinstance(job["lines"], list):
        return "job.lines must be a list"
    for i, line in enumerate(job["lines"]):
        for key in ("line_id", "chunks", "out_path"):
            if key not in line:
                return f"job.lines[{i}] missing required field: {key}"
        if not isinstance(line["chunks"], list) or len(line["chunks"]) == 0:
            return f"job.lines[{i}].chunks must be a non-empty list"
    return None


def _proportional_spans(texts: list[str], total_seconds: float) -> list[tuple[float, float]]:
    total_chars = sum(len(t) for t in texts) or len(texts)
    spans: list[tuple[float, float]] = []
    cursor = 0.0
    for i, t in enumerate(texts):
        frac = (len(t) / total_chars) if total_chars else (1 / len(texts))
        is_last = i == len(texts) - 1
        end = total_seconds if is_last else cursor + total_seconds * frac
        spans.append((cursor, end))
        cursor = end
    return spans


def dry_run(job: dict[str, Any], result_path: str) -> None:
    lines_out = []
    for line in job["lines"]:
        out_path = line["out_path"]
        directory = os.path.dirname(os.path.abspath(out_path)) or "."
        os.makedirs(directory, exist_ok=True)
        n_frames = int(SAMPLE_RATE * DRY_RUN_SECONDS)
        with wave.open(out_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(b"\x00\x00" * n_frames)

        texts: list[str] = line["chunks"]
        spans = _proportional_spans(texts, DRY_RUN_SECONDS)
        chunks_out = [{"text": t, "start": s, "end": e} for t, (s, e) in zip(texts, spans)]
        lines_out.append({
            "line_id": line["line_id"], "wav_path": out_path, "duration_seconds": DRY_RUN_SECONDS,
            "chunks": chunks_out, "words": None, "alignment": "chunk",
        })
    write_result(result_path, {"ok": True, "lines": lines_out})


def _generate_chunk(model: Any, np_mod: Any, text: str, ref_audio: str, ref_text: str, num_step: int, speed: float, language: str | None) -> Any:
    """Reads one chunk, retrying up to `MAX_CHUNK_ATTEMPTS - 1` more times when OmniVoice produced empty or
    NaN-containing audio (spec: "chunk có độ dài 0 hoặc nan → đọc lại tối đa 2 lần").

    `language` is the job's language code, forwarded to `OmniVoice.generate` because the model reads better
    when it is told which language the text is in. An unrecognised value is not a failure: OmniVoice's
    `_resolve_language` logs a warning and falls back to language-agnostic mode, which is exactly what this
    did for every call before task 11.
    """
    last_error: Exception | None = None
    for _attempt in range(MAX_CHUNK_ATTEMPTS):
        try:
            raw = model.generate(text=text, language=language, ref_audio=ref_audio, ref_text=ref_text, num_step=num_step, speed=speed)[0]
        except Exception as e:
            last_error = e
            continue
        arr = np_mod.asarray(raw, dtype=np_mod.float32)
        if arr.size > 0 and not np_mod.isnan(arr).any():
            return arr
        last_error = RuntimeError(f"chunk produced {'empty' if arr.size == 0 else 'NaN'} audio for text: {text[:80]!r}")
    raise last_error if last_error is not None else RuntimeError("chunk generation failed")


def _synth_line(model: Any, np_mod: Any, line: dict[str, Any], ref_audio: str, ref_text: str, num_step: int, speed: float, language: str | None) -> tuple[Any, list[dict[str, Any]]]:
    pause_seconds = float(line.get("pause_seconds") or 0.0)
    pause_samples = np_mod.zeros(int(round(pause_seconds * SAMPLE_RATE)), dtype=np_mod.float32)
    parts: list[Any] = []
    chunks_out: list[dict[str, Any]] = []
    cursor = 0.0
    texts: list[str] = line["chunks"]
    for i, text in enumerate(texts):
        arr = _generate_chunk(model, np_mod, text, ref_audio, ref_text, num_step, speed, language)
        duration = len(arr) / SAMPLE_RATE
        start = cursor
        end = cursor + duration
        chunks_out.append({"text": text, "start": start, "end": end})
        parts.append(arr)
        cursor = end
        if i < len(texts) - 1 and pause_samples.size > 0:
            parts.append(pause_samples)
            cursor += pause_seconds
    full = np_mod.concatenate(parts) if parts else np_mod.zeros(0, dtype=np_mod.float32)
    return full, chunks_out


def run(job: dict[str, Any], result_path: str) -> None:
    ref_audio = job["ref_audio"]
    if not os.path.exists(ref_audio):
        write_result(result_path, {"ok": False, "kind": "contract", "reason": f"ref_audio not found: {ref_audio}"})
        return

    try:
        import numpy as np
        import soundfile as sf
        import torch
        from omnivoice import OmniVoice
    except ImportError as e:
        write_result(result_path, {"ok": False, "kind": "contract", "reason": f"required python package not importable: {e}"})
        return

    device = job["device"]
    if device.startswith("cuda") and not torch.cuda.is_available():
        write_result(result_path, {"ok": False, "kind": "contract", "reason": f"device {device!r} requested but CUDA is not available"})
        return

    try:
        model = OmniVoice.from_pretrained(job["model"], device_map=device, dtype=getattr(torch, job["dtype"]))
    except Exception as e:  # model load / download / OOM
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"failed to load omnivoice model: {e}"})
        return

    lines_out: list[dict[str, Any]] = []
    try:
        for line in job["lines"]:
            audio, chunks_out = _synth_line(model, np, line, ref_audio, job["ref_text"], job["num_step"], job["speed"], job["language"])
            out_path = line["out_path"]
            os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
            sf.write(out_path, audio, SAMPLE_RATE)
            lines_out.append({
                "line_id": line["line_id"], "wav_path": out_path, "duration_seconds": len(audio) / SAMPLE_RATE,
                "chunks": chunks_out, "words": None, "alignment": "chunk",
            })
    except RuntimeError as e:
        kind_reason = f"out of memory: {e}" if "out of memory" in str(e).lower() else f"tts synthesis failed: {e}"
        write_result(result_path, {"ok": False, "kind": "transient", "reason": kind_reason})
        return
    except Exception as e:
        write_result(result_path, {"ok": False, "kind": "transient", "reason": f"tts synthesis failed: {e}"})
        return

    # Free the TTS model before loading the alignment model (spec: "Giải phóng mô hình TTS ... trước khi
    # nạp mô hình căn chỉnh") -- the two rarely fit in VRAM together on a single consumer GPU.
    del model
    try:
        torch.cuda.empty_cache()
    except Exception:
        pass

    if job.get("align"):
        align_model = None
        metadata = None
        try:
            import whisperx

            align_model, metadata = whisperx.load_align_model(language_code=job["language"], device=device)
        except Exception as e:
            log("warn", "alignment model unavailable, falling back to chunk-level timing", reason=str(e))

        if align_model is not None:
            for entry in lines_out:
                try:
                    audio_arr = whisperx.load_audio(entry["wav_path"])
                    full_text = " ".join(c["text"] for c in entry["chunks"])
                    aligned = whisperx.align(
                        [{"text": full_text, "start": 0.0, "end": entry["duration_seconds"]}],
                        align_model, metadata, audio_arr, device, return_char_alignments=False,
                    )
                    words = [
                        {"word": w["word"], "start": w["start"], "end": w["end"], **({"score": w["score"]} if "score" in w else {})}
                        for seg in aligned.get("segments", [])
                        for w in seg.get("words", [])
                        if "start" in w and "end" in w
                    ]
                    entry["words"] = words
                    entry["alignment"] = "word"
                except Exception as e:
                    log("warn", "alignment failed for line, keeping chunk-level timing", line_id=entry["line_id"], reason=str(e))

    write_result(result_path, {"ok": True, "lines": lines_out})


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
