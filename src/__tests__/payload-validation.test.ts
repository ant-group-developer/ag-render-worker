/**
 * Test: kiểm payload validation cho studio.tts, studio.render_preview, studio.render_final.
 */
import { StudioTtsPayloadSchema, StudioRenderPayloadSchema } from '@ag-farm/protocol';

describe('StudioTtsPayloadSchema', () => {
  const validTts = {
    production_id: 'prod-001',
    language: 'vi',
    voice: { reference: null, reference_text: null, speed: 1 },
    lines: [{ line_id: 'L001', text: 'Xin chào', pause_seconds: null }],
    align_words: false,
  };

  test('valid TTS payload parses OK', () => {
    const result = StudioTtsPayloadSchema.safeParse(validTts);
    expect(result.success).toBe(true);
  });

  test('missing production_id fails', () => {
    const bad = { ...validTts, production_id: '' };
    expect(StudioTtsPayloadSchema.safeParse(bad).success).toBe(false);
  });

  test('invalid line_id format fails', () => {
    const bad = {
      ...validTts,
      lines: [{ line_id: 'line1', text: 'test', pause_seconds: null }],
    };
    expect(StudioTtsPayloadSchema.safeParse(bad).success).toBe(false);
  });

  test('speed out of range fails', () => {
    const bad = { ...validTts, voice: { ...validTts.voice, speed: 3 } };
    expect(StudioTtsPayloadSchema.safeParse(bad).success).toBe(false);
  });

  test('empty lines array fails', () => {
    const bad = { ...validTts, lines: [] };
    expect(StudioTtsPayloadSchema.safeParse(bad).success).toBe(false);
  });

  test('voice reference with library: prefix parses OK', () => {
    const p = {
      ...validTts,
      voice: { reference: 'library:voices/ref.wav', reference_text: 'Xin chào', speed: 1 },
    };
    const result = StudioTtsPayloadSchema.safeParse(p);
    expect(result.success).toBe(true);
  });

  test('line text too long fails', () => {
    const bad = {
      ...validTts,
      lines: [{ line_id: 'L001', text: 'a'.repeat(1201), pause_seconds: null }],
    };
    expect(StudioTtsPayloadSchema.safeParse(bad).success).toBe(false);
  });
});

describe('StudioRenderPayloadSchema', () => {
  const validRender = {
    production_id: 'prod-001',
    revision: 1,
    composition: 'stage:renders/1/composition.json',
    canvas: { width: 1920, height: 1080 },
    handle_seconds: 1,
    output: 'renders/1/final.mp4',
  };

  test('valid render payload parses OK', () => {
    const result = StudioRenderPayloadSchema.safeParse(validRender);
    expect(result.success).toBe(true);
  });

  test('negative revision fails', () => {
    const bad = { ...validRender, revision: -1 };
    expect(StudioRenderPayloadSchema.safeParse(bad).success).toBe(false);
  });

  test('canvas too small fails', () => {
    const bad = { ...validRender, canvas: { width: 100, height: 100 } };
    expect(StudioRenderPayloadSchema.safeParse(bad).success).toBe(false);
  });

  test('handle_seconds negative fails', () => {
    const bad = { ...validRender, handle_seconds: -1 };
    expect(StudioRenderPayloadSchema.safeParse(bad).success).toBe(false);
  });

  test('output with .. segment fails', () => {
    const bad = { ...validRender, output: 'renders/../etc/passwd' };
    expect(StudioRenderPayloadSchema.safeParse(bad).success).toBe(false);
  });

  test('default handle_seconds is 1 when not provided', () => {
    const noHandle = {
      production_id: 'prod-001',
      revision: 0,
      composition: 'stage:comp.json',
      canvas: { width: 320, height: 180 },
      output: 'out/v.mp4',
    };
    const result = StudioRenderPayloadSchema.safeParse(noHandle);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handle_seconds).toBe(1);
    }
  });
});
