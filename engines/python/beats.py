"""Beats of a background track (job `studio.beats`, plan 2026-10-15 feedback-vps §4.7), with librosa. Invoked by the
render worker as a short-lived child process, like transcribe.py:

    python beats.py --job <job.json> --result <result.json> [--dry-run]

Job:    { beats_per_bar, items: [{ track_id, audio_path, parts: [start_s, ...] }] }
        `audio_path` is a mono WAV the worker made with ffmpeg; `parts` are where each joined song after the first starts.
Result: { ok: true, engine: "librosa:<version>", tracks: [{ track_id, duration_s, bpm, beats_per_bar, beats, downbeats,
          sections: [{ start, end, bpm }] }] }
      | { ok: false, kind: "contract" | "transient", reason }

Each song of a joined track is tracked on its own (their tempos differ). librosa finds the beats; the first beat of a bar
is the phase of every `beats_per_bar`-th beat with the most low-end energy and onset strength (kick drums and bass notes
fall on it far more often than on the other beats). Exit code is always 0. `--dry-run` imports neither numpy nor librosa:
it checks the job and answers no beats, so tests can exercise the process and JSON contract on a machine without them.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import engine_io as _io

read_job = _io.read_job
write_result = _io.write_result
log = _io.log

SR = 22050
HOP = 512
# a song shorter than this has too few beats to find a tempo in
MIN_SECTION_S = 4.0
# kick drum and bass
LOW_HZ = 150.0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True)
    p.add_argument("--result", required=True)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(argv)


def check_job(job: dict[str, Any]) -> str | None:
    """The reason the job is unusable, or None."""
    bpb = job.get("beats_per_bar")
    if not isinstance(bpb, int) or bpb < 2 or bpb > 12:
        return "beats_per_bar must be an integer 2-12"
    items = job.get("items")
    if not isinstance(items, list) or not items:
        return "items must be a non-empty list"
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("track_id"), str) or not isinstance(it.get("audio_path"), str):
            return "each item needs track_id and audio_path"
        parts = it.get("parts", [])
        if not isinstance(parts, list) or any(not isinstance(p, (int, float)) or p <= 0 for p in parts):
            return f"{it['track_id']}: parts must be positive seconds"
        if list(parts) != sorted(parts):
            return f"{it['track_id']}: parts must be in order"
    return None


def r3(x: float) -> float:
    return round(float(x), 3)


def downbeat_phase(np: Any, scores: Any, bpb: int) -> int:
    """The phase k (0..bpb-1) whose beats k, k+bpb, ... score highest on average."""
    best, best_score = 0, -1.0
    for k in range(min(bpb, len(scores))):
        s = float(np.mean(scores[k::bpb]))
        if s > best_score:
            best, best_score = k, s
    return best


def analyse_section(np: Any, librosa: Any, y: Any, start: float, bpb: int) -> tuple[float | None, list[float], list[float]]:
    """(bpm, beats, downbeats) of one song, beats in seconds of the whole track."""
    if len(y) < MIN_SECTION_S * SR:
        return None, [], []
    onset = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    _tempo, frames = librosa.beat.beat_track(onset_envelope=onset, sr=SR, hop_length=HOP, units="frames")
    frames = np.asarray(frames, dtype=int)
    if len(frames) < 2 * bpb:
        return None, [], []
    # the tempo the beats keep: their mean gap, leaving out a skipped or doubled beat (librosa's own estimate and any one
    # gap sit on the frame grid: 117.5 for a song at 120)
    gaps = np.diff(librosa.frames_to_time(frames, sr=SR, hop_length=HOP))
    med = float(np.median(gaps))
    bpm = 60.0 / float(np.mean(gaps[np.abs(gaps - med) <= 0.25 * med]))
    # low-end energy per frame: the song through a low-pass filter (a spectrogram of an hour-long mix would not fit in memory)
    from scipy.signal import butter, sosfilt
    low = librosa.feature.rms(y=sosfilt(butter(4, LOW_HZ, btype="low", fs=SR, output="sos"), y), frame_length=2048, hop_length=HOP)[0]
    n = min(len(onset), len(low))
    frames = frames[frames < n]
    norm = lambda a: a / (float(np.max(a)) or 1.0)  # noqa: E731
    scores = norm(onset[:n])[frames] + norm(low[:n])[frames]
    phase = downbeat_phase(np, scores, bpb)
    times = librosa.frames_to_time(frames, sr=SR, hop_length=HOP) + start
    beats = [r3(t) for t in times]
    downbeats = beats[phase::bpb]
    return (round(bpm, 1) if bpm > 0 else None), beats, downbeats


def analyse(item: dict[str, Any], bpb: int) -> dict[str, Any]:
    import numpy as np
    import librosa
    import soundfile as sf

    y, sr = sf.read(item["audio_path"], dtype="float32", always_2d=False)
    if getattr(y, "ndim", 1) > 1:
        y = y.mean(axis=1)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    duration = len(y) / SR
    if duration <= 0:
        raise ValueError("empty audio")
    bounds = [0.0] + [float(p) for p in item.get("parts", []) if 0 < float(p) < duration] + [duration]
    beats: list[float] = []
    downbeats: list[float] = []
    sections = []
    for a, b in zip(bounds, bounds[1:]):
        bpm, sb, sd = analyse_section(np, librosa, y[int(a * SR):int(b * SR)], a, bpb)
        # a beat of the fade into the next song belongs to that song
        sb = [t for t in sb if a <= t < b]
        sd = [t for t in sd if a <= t < b]
        beats += sb
        downbeats += sd
        sections.append({"start": r3(a), "end": r3(b), "bpm": bpm})
    timed = [(s["bpm"], s["end"] - s["start"]) for s in sections if s["bpm"]]
    # the tempo heard longest
    bpm = max(timed, key=lambda x: x[1])[0] if timed else None
    return {
        "track_id": item["track_id"], "duration_s": r3(duration), "bpm": bpm, "beats_per_bar": bpb,
        "beats": beats, "downbeats": downbeats, "sections": sections,
    }


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        job = read_job(args.job)
    except Exception as e:  # noqa: BLE001
        write_result(args.result, {"ok": False, "kind": "contract", "reason": f"cannot read job: {e}"})
        return 0
    bad = check_job(job)
    if bad:
        write_result(args.result, {"ok": False, "kind": "contract", "reason": bad})
        return 0
    bpb = job["beats_per_bar"]
    if args.dry_run:
        tracks = [{"track_id": it["track_id"], "duration_s": 1.0, "bpm": None, "beats_per_bar": bpb, "beats": [], "downbeats": [],
                   "sections": [{"start": 0.0, "end": 1.0, "bpm": None}]} for it in job["items"]]
        write_result(args.result, {"ok": True, "engine": "librosa:dry-run", "tracks": tracks})
        return 0
    try:
        import librosa
    except Exception as e:  # noqa: BLE001
        write_result(args.result, {"ok": False, "kind": "contract", "reason": f"librosa is not installed: {e}"})
        return 0
    tracks = []
    for it in job["items"]:
        if not os.path.isfile(it["audio_path"]):
            write_result(args.result, {"ok": False, "kind": "contract", "reason": f"{it['track_id']}: no file {it['audio_path']}"})
            return 0
        try:
            tracks.append(analyse(it, bpb))
        except MemoryError as e:
            write_result(args.result, {"ok": False, "kind": "transient", "reason": f"{it['track_id']}: out of memory: {e}"})
            return 0
        except Exception as e:  # noqa: BLE001
            write_result(args.result, {"ok": False, "kind": "contract", "reason": f"{it['track_id']}: cannot analyse: {e}"})
            return 0
        log("info", "beats found", track_id=it["track_id"], bpm=tracks[-1]["bpm"], beats=len(tracks[-1]["beats"]))
    write_result(args.result, {"ok": True, "engine": f"librosa:{librosa.__version__}", "tracks": tracks})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
