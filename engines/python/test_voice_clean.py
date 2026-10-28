"""Tests for voice_clean.py (stdlib only): python engines/python/test_voice_clean.py"""

from __future__ import annotations

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import voice_clean as vc  # noqa: E402

SR = 24000


def silence(seconds: float) -> list[float]:
    return [0.0] * int(seconds * SR)


def tone(seconds: float, freq: float, amp: float, wobble: float = 0.0) -> list[float]:
    n = int(seconds * SR)
    out = []
    for i in range(n):
        t = i / SR
        a = amp * (1 + wobble * math.sin(2 * math.pi * 3 * t)) / (1 + wobble)
        out.append(a * math.sin(2 * math.pi * freq * t))
    return out


def outch() -> list[float]:
    """The leaked burst: a vowel, a click, a fricative."""
    return tone(0.23, 320, 0.3) + [0.9, -0.9] * 24 + tone(0.15, 4200, 0.12)


def words(seed: int) -> list[float]:
    return tone(0.6 + 0.1 * seed, 180 + 15 * seed, 0.5, wobble=0.5) + silence(0.08) + tone(0.9, 220 + 10 * seed, 0.45, wobble=0.3)


def leaked(seed: int) -> list[float]:
    return silence(0.12) + outch() + silence(0.3) + words(seed) + silence(0.4)


class PlanCutsTest(unittest.TestCase):
    def test_cuts_a_burst_that_opens_every_chunk(self) -> None:
        chunks = [leaked(s) for s in range(5)]
        cuts, n = vc.plan_cuts(chunks, SR)
        self.assertEqual(n, 5)
        words_at = int((0.12 + 0.23 + 48 / SR + 0.15 + 0.3) * SR)
        for (start, end), c in zip(cuts, chunks):
            self.assertGreater(start, words_at - int(0.06 * SR))
            self.assertLessEqual(start, words_at)
            self.assertLess(end, len(c) - int(0.25 * SR))

    def test_keeps_the_burst_of_a_lone_chunk(self) -> None:
        # one chunk alone cannot be told from a short first word: only its leading silence goes
        cuts, n = vc.plan_cuts([leaked(0)], SR)
        self.assertEqual(n, 0)
        self.assertLess(cuts[0][0], int(0.12 * SR))
        self.assertGreater(cuts[0][0], int(0.12 * SR) - int(0.04 * SR))

    def test_keeps_short_first_words_that_differ(self) -> None:
        chunks = [
            silence(0.05) + tone(d, f, a, wobble=w) + silence(0.25) + words(i) + silence(0.2)
            for i, (d, f, a, w) in enumerate([(0.18, 200, 0.5, 0.0), (0.42, 260, 0.3, 0.9), (0.3, 150, 0.6, 0.4), (0.55, 300, 0.4, 0.7)])
        ]
        _cuts, n = vc.plan_cuts(chunks, SR)
        self.assertEqual(n, 0)

    def test_cuts_only_the_chunks_with_the_burst(self) -> None:
        chunks = [leaked(s) for s in range(4)] + [silence(0.1) + words(9) + silence(0.2)]
        cuts, n = vc.plan_cuts(chunks, SR)
        self.assertEqual(n, 4)
        self.assertLess(cuts[4][0], int(0.1 * SR))

    def test_leaves_a_silent_chunk_whole(self) -> None:
        c = silence(1.0)
        self.assertEqual(vc.plan_cuts([c], SR), ([(0, len(c))], 0))


class HeadBurstTest(unittest.TestCase):
    def test_no_burst_when_the_words_start_at_once(self) -> None:
        c = silence(0.05) + words(1)
        env = vc.envelope_db(c, SR)
        self.assertIsNone(vc.head_burst(env, vc.sound_threshold(max(abs(v) for v in c))))

    def test_finds_burst_and_words(self) -> None:
        c = leaked(2)
        env = vc.envelope_db(c[: int(vc.HEAD_SECONDS * SR)], SR)
        burst = vc.head_burst(env, vc.sound_threshold(max(abs(v) for v in c)))
        assert burst is not None
        start, end, first = burst
        self.assertAlmostEqual(start * vc.FRAME_SECONDS, 0.12, delta=0.02)
        self.assertAlmostEqual(end * vc.FRAME_SECONDS, 0.12 + 0.38 + 48 / SR, delta=0.03)
        self.assertGreaterEqual((first - end) * vc.FRAME_SECONDS, vc.GAP_MIN)


if __name__ == "__main__":
    unittest.main()
