"""Cleans the chunks OmniVoice read before they are joined into a line (`tts.py`). Pure Python on lists of float
samples (-1..1), no numpy, so it is tested without the GPU stack: `python engines/python/test_voice_clean.py`.

1. A sound the voice sample leaks into every chunk. With a sample whose `ref_text` does not match it, or one cut
   mid-word, OmniVoice opens each chunk with the same short burst (heard as "outch": a vowel, a click, a "ch")
   and a gap before the real words (Studio video "Why Is Ninh Binh So Quiet?", 2026-10-27: 160 hits for
   153 lines). One chunk alone cannot tell such a burst from a short first word, so a burst is cut only when the
   same shape opens enough chunks of the job (`shared_bursts`).
2. Silence around the words is trimmed to a short pad: Studio places a line by its own lead, the wav's leading
   silence only delays the speech (`speech_bounds`).
3. A 10 ms fade at both ends, so a cut never clicks (`tts.py` applies it to the array).
"""

from __future__ import annotations

import math
from typing import Sequence

FRAME_SECONDS = 0.01
HEAD_SECONDS = 1.6  # a burst + its gap lie well inside this
TAIL_SECONDS = 2.0
SOUND_BELOW_PEAK_DB = 30.0  # a frame this far under the chunk's peak counts as quiet
SOUND_FLOOR_DB = -60.0
BURST_START_MAX = 0.4  # the burst opens the chunk
BURST_MAX = 0.6
GAP_MIN = 0.2
BURST_FRAMES = 45  # the shape compared between chunks (0.45 s from the burst's first frame)
MATCH_CORRELATION = 0.8
MIN_SHARED = 3  # chunks with the same burst before any is cut
MIN_SHARED_SHARE = 0.3
LEAD_PAD = 0.03
TAIL_PAD = 0.08
FADE_SECONDS = 0.01


def envelope_db(samples: Sequence[float], sr: int) -> list[float]:
    """10 ms RMS frames in dBFS."""
    hop = max(1, int(sr * FRAME_SECONDS))
    out: list[float] = []
    for i in range(0, len(samples) - hop + 1, hop):
        s = 0.0
        for v in samples[i:i + hop]:
            s += v * v
        out.append(10 * math.log10(s / hop + 1e-12))
    return out


def sound_threshold(peak: float) -> float:
    peak_db = 20 * math.log10(abs(peak) + 1e-9)
    return max(peak_db - SOUND_BELOW_PEAK_DB, SOUND_FLOOR_DB)


def head_burst(env: list[float], threshold: float) -> tuple[int, int, int] | None:
    """(first frame, frame after the burst, first frame of the words) when the chunk opens with a short sound, a gap
    of at least `GAP_MIN` and then more sound; None otherwise."""
    loud = [v > threshold for v in env]
    start = next((i for i, x in enumerate(loud) if x), None)
    if start is None or start > BURST_START_MAX / FRAME_SECONDS:
        return None
    gap = int(round(GAP_MIN / FRAME_SECONDS))
    i = start
    while i < len(loud):
        if not loud[i]:
            j = i
            while j < len(loud) and not loud[j]:
                j += 1
            if j - i >= gap:
                if i - start > BURST_MAX / FRAME_SECONDS or j >= len(loud):
                    return None
                return start, i, j
            i = j
        else:
            i += 1
    return None


def _normalised(v: list[float]) -> list[float]:
    m = sum(v) / len(v)
    c = [x - m for x in v]
    n = math.sqrt(sum(x * x for x in c)) or 1.0
    return [x / n for x in c]


def burst_shape(env: list[float], burst: tuple[int, int, int], threshold: float) -> list[float]:
    start = burst[0]
    shape = env[start:start + BURST_FRAMES]
    return _normalised([max(v, threshold) for v in shape] + [threshold] * (BURST_FRAMES - len(shape)))


def shared_bursts(shapes: list[list[float] | None]) -> set[int]:
    """Indexes of the chunks whose opening burst has the same shape as enough other chunks' bursts."""
    found = [(i, s) for i, s in enumerate(shapes) if s is not None]
    need = max(MIN_SHARED, math.ceil(MIN_SHARED_SHARE * len(shapes)))
    if len(found) < need:
        return set()
    out: set[int] = set()
    for i, a in found:
        alike = 1 + sum(1 for j, b in found if j != i and sum(p * q for p, q in zip(a, b)) >= MATCH_CORRELATION)
        if alike >= need:
            out.add(i)
    return out


def speech_bounds(head_env: list[float], tail_env: list[float], tail_start: int, n_samples: int, sr: int, threshold: float, start_frame: int | None = None) -> tuple[int, int]:
    """Sample range [start, end) of the words with `LEAD_PAD`/`TAIL_PAD` around them (`tail_env` begins at sample
    `tail_start`); `start_frame` (a frame of the head) overrides where the words start. The whole chunk when nothing
    is louder than the threshold."""
    hop = max(1, int(sr * FRAME_SECONDS))
    first = start_frame if start_frame is not None else next((i for i, v in enumerate(head_env) if v > threshold), None)
    last = next((i for i in range(len(tail_env) - 1, -1, -1) if tail_env[i] > threshold), None)
    if first is None or last is None:
        return 0, n_samples
    start = max(0, first * hop - int(LEAD_PAD * sr))
    end = min(n_samples, tail_start + (last + 1) * hop + int(TAIL_PAD * sr))
    if end <= start:
        return 0, n_samples
    return start, end


def plan_cuts(chunks: list[Sequence[float]], sr: int) -> tuple[list[tuple[int, int]], int]:
    """Where to cut each chunk: [(start, end)] in samples and how many leading bursts are cut."""
    head_n = int(HEAD_SECONDS * sr)
    tail_n = int(TAIL_SECONDS * sr)
    infos = []
    for c in chunks:
        peak = max((abs(v) for v in c), default=0.0)
        thr = sound_threshold(peak)
        head = envelope_db(c[:head_n], sr)
        tail_start = max(0, len(c) - tail_n)
        tail = envelope_db(c[tail_start:], sr)
        burst = head_burst(head, thr)
        infos.append((thr, head, tail, tail_start, burst))
    shapes = [burst_shape(head, burst, thr) if burst else None for thr, head, _tail, _ts, burst in infos]
    cut = shared_bursts(shapes)
    out = []
    for i, (c, (thr, head, tail, tail_start, burst)) in enumerate(zip(chunks, infos)):
        out.append(speech_bounds(head, tail, tail_start, len(c), sr, thr, burst[2] if i in cut and burst else None))
    return out, len(cut)
