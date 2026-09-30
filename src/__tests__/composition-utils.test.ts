/**
 * Test: thu thập input, ghi đè path, range-cut math.
 */
import { collectCompositionInputs, rewriteCompositionPaths } from '../composition-utils.js';
import type { Composition } from '../composition-utils.js';

// ---- Fixture composition ----

function makeComposition(overrides: Partial<Composition> = {}): Composition {
  return {
    schema_version: 'composition/v1',
    output: { width: 1920, height: 1080, fps: 25, codec: 'h264' },
    voice: 'tts',
    language: 'vi',
    total_seconds: 10,
    request_id: 'cr_001',
    brand: {
      channel_id: 'ch1',
      revision: 1,
      dir: 'library:brands/ch1',
      fonts_dir: 'library:brands/ch1/fonts',
      checksums: {},
    },
    segments: [
      {
        order: 0,
        source_id: 'src-001',
        source_path: 'segment:seg-001',
        in: 1,
        out: 4,
        start: 0,
        end: 3,
        fit: 'scale_pad',
        has_audio: true,
        transition_out: { kind: 'cut', seconds: 0, tail_available: false },
      },
      {
        order: 1,
        source_id: 'src-002',
        source_path: 'segment:seg-002',
        in: 2,
        out: 7,
        start: 3,
        end: 8,
        fit: 'scale_crop',
        has_audio: false,
        transition_out: { kind: 'dissolve', seconds: 0.5, tail_available: true },
      },
    ],
    text_events: [],
    captions: { mode: 'none', cues: [] },
    music: {
      track_id: 'track1',
      path: 'library:music/track1.mp3',
      loop: true,
      fade_in: 1,
      fade_out: 1,
      cues: [],
      duck: {},
    },
    logo: {
      path: 'library:logo.png',
      corner: 'right',
      opacity: 0.8,
      height_px: 100,
    },
    narration: [
      { line_id: 'L001', wav: 'stage:tts/L001.wav', start: 0, end: 3 },
      { line_id: 'L002', wav: 'stage:tts/L002.wav', start: 3, end: 8 },
    ],
    transitions: { requested: 1, applied: 1, downgraded: [] },
    warnings: [],
    ...overrides,
  };
}

// ---- collectCompositionInputs ----

describe('collectCompositionInputs', () => {
  test('collects all expected inputs', () => {
    const comp = makeComposition();
    const inputs = collectCompositionInputs(comp);

    expect(inputs.has('segment:seg-001')).toBe(true);
    expect(inputs.has('segment:seg-002')).toBe(true);
    expect(inputs.has('stage:tts/L001.wav')).toBe(true);
    expect(inputs.has('stage:tts/L002.wav')).toBe(true);
    expect(inputs.has('library:music/track1.mp3')).toBe(true);
    expect(inputs.has('library:logo.png')).toBe(true);
    expect(inputs.has('library:brands/ch1')).toBe(true);
    expect(inputs.has('library:brands/ch1/fonts')).toBe(true);
    expect(inputs.size).toBe(8);
  });

  test('no music - no music input', () => {
    const comp = makeComposition({ music: null });
    const inputs = collectCompositionInputs(comp);
    for (const name of inputs) {
      expect(name).not.toContain('music');
    }
  });

  test('no logo - no logo input', () => {
    const comp = makeComposition({ logo: null });
    const inputs = collectCompositionInputs(comp);
    for (const name of inputs) {
      expect(name).not.toContain('logo');
    }
  });

  test('no brand - no brand inputs', () => {
    const comp = makeComposition({ brand: null });
    const inputs = collectCompositionInputs(comp);
    for (const name of inputs) {
      expect(!name.startsWith('library:brands')).toBe(true);
    }
  });

  test('empty segments - no segment inputs', () => {
    const comp = makeComposition({ segments: [] });
    const inputs = collectCompositionInputs(comp);
    for (const name of inputs) {
      expect(!name.startsWith('segment:')).toBe(true);
    }
  });
});

// ---- rewriteCompositionPaths ----

describe('rewriteCompositionPaths', () => {
  test('rewrites segment source_path', () => {
    const comp = makeComposition();
    const mapping = new Map([['segment:seg-001', '/local/seg001.mp4']]);
    const out = rewriteCompositionPaths(comp, mapping);
    expect(out.segments[0]!.source_path).toBe('/local/seg001.mp4');
    // Unmapped stays original
    expect(out.segments[1]!.source_path).toBe('segment:seg-002');
  });

  test('rewrites narration wav paths', () => {
    const comp = makeComposition();
    const mapping = new Map([
      ['stage:tts/L001.wav', '/local/L001.wav'],
      ['stage:tts/L002.wav', '/local/L002.wav'],
    ]);
    const out = rewriteCompositionPaths(comp, mapping);
    expect(out.narration[0]!.wav).toBe('/local/L001.wav');
    expect(out.narration[1]!.wav).toBe('/local/L002.wav');
  });

  test('rewrites music path', () => {
    const comp = makeComposition();
    const mapping = new Map([['library:music/track1.mp3', '/local/track1.mp3']]);
    const out = rewriteCompositionPaths(comp, mapping);
    expect(out.music!.path).toBe('/local/track1.mp3');
  });

  test('rewrites logo path', () => {
    const comp = makeComposition();
    const mapping = new Map([['library:logo.png', '/local/logo.png']]);
    const out = rewriteCompositionPaths(comp, mapping);
    expect(out.logo!.path).toBe('/local/logo.png');
  });

  test('rewrites brand dir and fonts_dir', () => {
    const comp = makeComposition();
    const mapping = new Map([
      ['library:brands/ch1', '/local/brands/ch1'],
      ['library:brands/ch1/fonts', '/local/brands/ch1/fonts'],
    ]);
    const out = rewriteCompositionPaths(comp, mapping);
    expect(out.brand!.dir).toBe('/local/brands/ch1');
    expect(out.brand!.fonts_dir).toBe('/local/brands/ch1/fonts');
  });

  test('does not mutate original composition', () => {
    const comp = makeComposition();
    const original = comp.segments[0]!.source_path;
    const mapping = new Map([['segment:seg-001', '/changed.mp4']]);
    rewriteCompositionPaths(comp, mapping);
    expect(comp.segments[0]!.source_path).toBe(original);
  });
});

