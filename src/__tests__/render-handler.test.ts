/**
 * Test: studio.render_preview handler.
 * Tạo lavfi clip nhỏ, build composition, gọi renderComposition qua handler,
 * kiểm tra manifest đầu ra và dims/duration của video.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const _require = createRequire(import.meta.url);

// ---- Resolve ffmpeg/ffprobe ----

function resolveBin(envKey: string, fallback: string, staticPkg: string): string {
  const fromEnv = process.env[envKey];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const mod = _require(staticPkg) as unknown;
    const p = mod && typeof mod === 'object' && 'path' in (mod as object)
      ? (mod as { path: unknown }).path
      : mod;
    if (typeof p === 'string' && p && existsSync(p)) return p;
  } catch { /* ignore */ }
  return fallback;
}

const FFMPEG = resolveBin('FFMPEG_PATH', 'ffmpeg', 'ffmpeg-static');
const FFPROBE = resolveBin('FFPROBE_PATH', 'ffprobe', 'ffprobe-static');

// ---- Tạo lavfi test video ----

/**
 * Tạo video test nhỏ từ lavfi (testsrc2) bằng ffmpeg.
 * Không cần file nguồn thật.
 */
async function createLavfiVideo(
  outputPath: string,
  durationSeconds: number,
  width: number,
  height: number,
): Promise<void> {
  const filter = `testsrc2=size=${width}x${height}:rate=25:duration=${durationSeconds}`;
  const args = [
    '-f', 'lavfi', '-i', filter,
    '-f', 'lavfi', '-i', `aevalsrc=0:c=mono:s=48000:d=${durationSeconds}`,
    '-c:v', 'libx264', '-crf', '30', '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-t', String(durationSeconds),
    '-y',
    outputPath,
  ];
  await execFileAsync(FFMPEG, args, { timeout: 30_000 });
}

// ---- Probe video ----

async function probeVideo(videoPath: string): Promise<{
  width: number;
  height: number;
  duration: number;
}> {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', videoPath];
  const { stdout } = await execFileAsync(FFPROBE, args, { timeout: 10_000, maxBuffer: 2_000_000 });
  const d = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const v = d.streams?.find((s) => s.codec_type === 'video');
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    duration: parseFloat(d.format?.duration ?? '0'),
  };
}

// ---- Fake sign server (file:// based) ----

/** Fake sign client that maps inputName → local file path */
class FakeSignClient {
  private readonly map = new Map<string, string>();
  private readonly spans = new Map<string, { start_ms: number; end_ms: number }>();

  /** `span`: where the segment sits inside the file, as ag-go `resolve` reports it. */
  register(inputName: string, localPath: string, span?: { start_ms: number; end_ms: number }): void {
    this.map.set(inputName, localPath);
    if (span) this.spans.set(inputName, span);
  }

  async sign(ops: Array<{ op: string; input?: string; output?: string }>): Promise<unknown[]> {
    return ops.map((op) => {
      if (op.op === 'get' && op.input) {
        const localPath = this.map.get(op.input);
        if (!localPath) throw new Error(`Unknown input: ${op.input}`);
        return {
          op: 'get',
          input: op.input,
          url: `file://${localPath.replace(/\\/g, '/')}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          size_bytes: null,
          content_type: 'video/mp4',
          cache_key: null,
          source: {
            source_kind: 'original',
            watermarked: false,
            start_ms: this.spans.get(op.input)?.start_ms ?? null,
            end_ms: this.spans.get(op.input)?.end_ms ?? null,
          },
        };
      }
      if (op.op === 'put' && op.output) {
        return {
          op: 'put',
          output: op.output,
          url: `file:///dev/null`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          headers: {},
        };
      }
      throw new Error(`Unhandled op: ${op.op}`);
    });
  }

  async getInput(inputName: string): Promise<{
    url: string;
    expiresAt: Date;
    sizeBytes: null;
    cacheKey: null;
  }> {
    const localPath = this.map.get(inputName);
    if (!localPath) throw new Error(`Unknown input: ${inputName}`);
    return {
      url: `file://${localPath.replace(/\\/g, '/')}`,
      expiresAt: new Date(Date.now() + 3600_000),
      sizeBytes: null,
      cacheKey: null,
    };
  }
}

// ---- Fake upload store ----

class FakeUploadStore {
  readonly uploaded = new Map<string, { localPath: string; contentType: string }>();
  readonly jsonUploads = new Map<string, unknown>();

  makeUpload() {
    return async (localPath: string, outputPath: string, contentType: string) => {
      this.uploaded.set(outputPath, { localPath, contentType });
    };
  }

  makeUploadJson() {
    return async (outputPath: string, data: unknown) => {
      this.jsonUploads.set(outputPath, data);
    };
  }

  makeDownload(sign: FakeSignClient) {
    return async (inputName: string, dest: string) => {
      const src = sign['map'].get(inputName) as string | undefined;
      if (!src) throw new Error(`download: unknown input ${inputName}`);
      const { copyFileSync } = await import('node:fs');
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    };
  }
}

// ---- Build composition fixture ----

function buildTestComposition(
  sourceVideoPath: string,
  narrationWavPath: string,
  outputPath: string,
  canvas: { width: number; height: number },
) {
  // Use valid schema values: schema_version matches harness.composition/v1,
  // request_id and source_id match their respective idSchema patterns.
  return {
    schema_version: 'harness.composition/v1',
    output: { width: canvas.width, height: canvas.height, fps: 25, codec: 'h264' },
    voice: 'tts',
    language: 'vi',
    total_seconds: 3,
    request_id: 'req_01ABCDEFGHJKMNPQRSTVWXYZ12',
    brand: null,
    segments: [
      {
        order: 0,
        source_id: 'src_01ABCDEFGHJKMNPQRSTVWXYZ12',
        source_path: 'segment:seg-001',
        in: 0.5,
        out: 3.5,
        start: 0,
        end: 3,
        fit: 'scale_pad',
        has_audio: true,
        transition_out: { kind: 'cut', seconds: 0, tail_available: false },
      },
    ],
    text_events: [],
    captions: { mode: 'none', cues: [] },
    music: null,
    logo: null,
    narration: [
      { line_id: 'L001', wav: 'stage:tts/L001.wav', start: 0, end: 3 },
    ],
    transitions: { requested: 0, applied: 0, downgraded: [] },
    warnings: [],
  };
}

// ---- Test suite ----

describe('studio.render_preview handler (integration)', () => {
  let testDir: string;
  let sourceVideoPath: string;
  let narrationWavPath: string;
  let compositionPath: string;
  let sign: FakeSignClient;
  let store: FakeUploadStore;

  const CANVAS = { width: 320, height: 180 };

  beforeAll(async () => {
    testDir = join(tmpdir(), `render-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });

    // Cần ffmpeg
    try {
      await execFileAsync(FFMPEG, ['-version'], { timeout: 5000 });
    } catch {
      console.log('ffmpeg not available, skipping render integration test');
      return;
    }

    // Tạo source video 5s 320x180
    sourceVideoPath = join(testDir, 'source.mp4');
    await createLavfiVideo(sourceVideoPath, 5, 320, 180);

    // Tạo narration WAV giả (silent)
    narrationWavPath = join(testDir, 'L001.wav');
    // WAV header + 24000 * 0.1s * 2 bytes = 4800 bytes silent audio
    const sampleRate = 24000;
    const numSamples = sampleRate * 3; // 3 seconds
    const wav = Buffer.alloc(44 + numSamples * 2);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + numSamples * 2, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);   // PCM
    wav.writeUInt16LE(1, 22);   // mono
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(numSamples * 2, 40);
    writeFileSync(narrationWavPath, wav);
  }, 30_000);

  beforeEach(() => {
    sign = new FakeSignClient();
    store = new FakeUploadStore();
  });

  test(
    'produces MP4 with correct dimensions',
    async () => {
      if (!existsSync(sourceVideoPath ?? '')) {
        console.log('Source video not created (ffmpeg unavailable), skipping');
        return;
      }

      sign.register('segment:seg-001', sourceVideoPath!);
      sign.register('stage:tts/L001.wav', narrationWavPath!);

      const workDir = join(testDir, `run-${randomUUID()}`);
      mkdirSync(workDir, { recursive: true });

      // Bọc composition trong file JSON
      compositionPath = join(workDir, 'composition.json');
      const comp = buildTestComposition(sourceVideoPath!, narrationWavPath!, 'renders/1/preview.mp4', CANVAS);
      writeFileSync(compositionPath, JSON.stringify(comp), 'utf8');

      sign.register('stage:renders/1/composition.json', compositionPath);

      const payload = {
        production_id: 'prod-test',
        revision: 1,
        composition: 'stage:renders/1/composition.json',
        canvas: CANVAS,
        handle_seconds: 0.5,
        output: 'renders/1/preview.mp4',
      };

      const ctx = {
        job: { id: 'job-render-test', type: 'studio.render_preview', attempt: 1, ticket: 't1', lease_token: 'l1', sign_url: 'http://fake/sign', payload, lane: 'interactive' },
        payload,
        workDir,
        sign,
        cache: {} as unknown,
        log: {
          info: (msg: string, ...args: unknown[]) => console.log('[render]', msg, ...args),
          warn: (msg: string, ...args: unknown[]) => console.warn('[render]', msg, ...args),
          error: (msg: string, ...args: unknown[]) => console.error('[render]', msg, ...args),
          debug: () => {},
          child: function() { return this; },
        },
        signal: new AbortController().signal,
        progress: () => {},
        download: store.makeDownload(sign),
        upload: store.makeUpload(),
        uploadJson: store.makeUploadJson(),
      };

      // Import handler dynamically to avoid circular import issues
      const { makeStudioRenderPreviewHandler } = await import('../render-handler.js');
      const handler = makeStudioRenderPreviewHandler({});

      const result = await handler(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);

      expect(result.manifest).toBe('render.json');

      // Check render.json was uploaded
      const renderManifest = store.jsonUploads.get('render.json');
      expect(renderManifest).toBeTruthy();

      const { RenderManifestSchema } = await import('@ag-farm/protocol');
      const parsed = RenderManifestSchema.safeParse(renderManifest);
      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.production_id).toBe('prod-test');
        expect(parsed.data.revision).toBe(1);
        expect(parsed.data.width).toBe(CANVAS.width);
        expect(parsed.data.height).toBe(CANVAS.height);
        expect(parsed.data.duration_s).toBeGreaterThan(0);
        expect(parsed.data.watermarked).toBe(false);
      }

      // Verify the output MP4 was uploaded and is a valid video
      const uploadedVideo = store.uploaded.get('renders/1/preview.mp4');
      expect(uploadedVideo).toBeTruthy();

      if (uploadedVideo) {
        const probe = await probeVideo(uploadedVideo.localPath);
        expect(probe.width).toBe(CANVAS.width);
        expect(probe.height).toBe(CANVAS.height);
        expect(probe.duration).toBeGreaterThan(0);
        expect(probe.duration).toBeLessThan(10);
      }
    },
    120_000,
  );
});

// ---- Segments that start mid-file, and one segment used by two clips ----

/** 12 s, 320x180: red 0–4 s, green 4–8 s, blue 8–12 s (one file, like an ag-go asset). */
async function createColourBands(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=4',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=25:d=4',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=4',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', outputPath,
  ], { timeout: 30_000 });
}

/** Mean colour of the frame at `t` as [r, g, b]. */
async function colourAt(videoPath: string, t: number): Promise<[number, number, number]> {
  const out = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 20_000 });
  return [out[0]!, out[1]!, out[2]!];
}
const dominant = (c: [number, number, number]) => (['red', 'green', 'blue'] as const)[c.indexOf(Math.max(...c))];

describe('studio.render_* cuts footage where ag-go says it is (whole-file URLs)', () => {
  test(
    'mid-file segments and two clips of one segment each get their own, correct cut',
    async () => {
      try { await execFileAsync(FFMPEG, ['-version'], { timeout: 5000 }); } catch { console.log('ffmpeg not available, skipping'); return; }
      const dir = join(tmpdir(), `render-span-${randomUUID()}`);
      mkdirSync(dir, { recursive: true });
      const bands = join(dir, 'bands.mp4');
      await createColourBands(bands);
      const wavPath = join(dir, 'L001.wav');
      const n = 24000 * 3;
      const wav = Buffer.alloc(44 + n * 2);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
      writeFileSync(wavPath, wav);

      const sign = new FakeSignClient();
      const store = new FakeUploadStore();
      // both inputs resolve to the SAME whole file; the spans say where each segment is
      sign.register('segment:seg-rg', bands, { start_ms: 2000, end_ms: 6000 });
      sign.register('segment:seg-b', bands, { start_ms: 8000, end_ms: 12000 });
      sign.register('stage:tts/L001.wav', wavPath);
      const clip = (order: number, input: string, inS: number, outS: number) => ({
        order, source_id: 'src_01ABCDEFGHJKMNPQRSTVWXYZ1' + String(order), source_path: input, in: inS, out: outS,
        start: order, end: order + 1, fit: 'scale_pad', has_audio: false,
        transition_out: { kind: 'cut', seconds: 0, tail_available: false },
      });
      const comp = {
        ...buildTestComposition(bands, wavPath, 'renders/2/preview.mp4', { width: 320, height: 180 }),
        segments: [
          clip(0, 'segment:seg-b', 8.5, 9.5),   // mid-file: blue
          clip(1, 'segment:seg-rg', 2.5, 3.5),  // red
          clip(2, 'segment:seg-rg', 4.5, 5.5),  // same input, same length, green
        ],
      };
      // the segment's source_id is shared by clips 1 and 2 in a real Studio composition
      comp.segments[2]!.source_id = comp.segments[1]!.source_id;
      const workDir = join(dir, 'work');
      mkdirSync(workDir, { recursive: true });
      const compPath = join(workDir, 'composition.json');
      writeFileSync(compPath, JSON.stringify(comp), 'utf8');
      sign.register('stage:composition.json', compPath);
      const payload = { production_id: 'prod-test', revision: 2, composition: 'stage:composition.json', canvas: { width: 320, height: 180 }, handle_seconds: 0.5, output: 'renders/2/preview.mp4' };
      const ctx = {
        job: { id: 'job-span', type: 'studio.render_preview', attempt: 1, ticket: 't', lease_token: 'l', sign_url: 'http://fake/sign', payload, lane: 'interactive' },
        payload, workDir, sign, cache: {} as unknown,
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: function () { return this; } },
        signal: new AbortController().signal, progress: () => {},
        download: store.makeDownload(sign), upload: store.makeUpload(), uploadJson: store.makeUploadJson(),
      };
      const { makeStudioRenderPreviewHandler } = await import('../render-handler.js');
      await makeStudioRenderPreviewHandler({})(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);

      const video = store.uploaded.get('renders/2/preview.mp4');
      expect(video).toBeTruthy();
      const probe = await probeVideo(video!.localPath);
      expect(probe.duration).toBeGreaterThan(2.8);
      expect(probe.duration).toBeLessThan(3.3);
      expect(dominant(await colourAt(video!.localPath, 0.5))).toBe('blue');
      expect(dominant(await colourAt(video!.localPath, 1.5))).toBe('red');
      expect(dominant(await colourAt(video!.localPath, 2.5))).toBe('green');
    },
    120_000,
  );

  test('clipSourceId is a valid, per-clip, stable source id', async () => {
    const { clipSourceId } = await import('../render-handler.js');
    const a = clipSourceId('src_01ABCDEFGHJKMNPQRSTVWXYZ12', 1);
    expect(a).toMatch(/^src_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(clipSourceId('src_01ABCDEFGHJKMNPQRSTVWXYZ12', 1)).toBe(a);
    expect(clipSourceId('src_01ABCDEFGHJKMNPQRSTVWXYZ12', 2)).not.toBe(a);
  });
});


// ---- Text and subtitles burnt in with Arial ----

/** Mean colour of a region of the frame at `t` (crop given as ffmpeg expressions). */
async function regionColourAt(videoPath: string, t: number, crop: string): Promise<[number, number, number]> {
  const out = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', `crop=${crop},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 20_000 });
  return [out[0]!, out[1]!, out[2]!];
}

describe('studio.render_* burns text and subtitles in Arial', () => {
  const CANVAS = { width: 640, height: 360 };
  let dir: string;
  let blue: string;
  let wavPath: string;
  let ffmpegOk = true;

  beforeAll(async () => {
    try { await execFileAsync(FFMPEG, ['-version'], { timeout: 5000 }); } catch { ffmpegOk = false; return; }
    dir = join(tmpdir(), `render-text-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    blue = join(dir, 'blue.mp4');
    await execFileAsync(FFMPEG, ['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', blue], { timeout: 30_000 });
    wavPath = join(dir, 'L001.wav');
    const n = 24000 * 3;
    const wav = Buffer.alloc(44 + n * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
    writeFileSync(wavPath, wav);
  }, 60_000);

  async function render(withText: boolean, extra: Record<string, unknown> = {}): Promise<string> {
    const sign = new FakeSignClient();
    const store = new FakeUploadStore();
    sign.register('segment:seg-001', blue, { start_ms: 0, end_ms: 4000 });
    sign.register('stage:tts/L001.wav', wavPath);
    const comp = {
      ...buildTestComposition(blue, wavPath, 'renders/3/preview.mp4', CANVAS),
      segments: buildTestComposition(blue, wavPath, 'renders/3/preview.mp4', CANVAS).segments.map((x) => ({ ...x, has_audio: false })),
      captions: withText
        ? { mode: 'burn-in', cues: [{ index: 1, start: 0, end: 3, lines: ['PHỞ BÒ HÀ NỘI MMMMMMMMMMMMMM'], raise_px: 0, words: [] }] }
        : { mode: 'none', cues: [] },
      text_events: withText
        ? [{ id: 'T001', kind: 'title', text: 'TIÊU ĐỀ MMMMMMMM', start: 0, end: 3, position: 'top_left', animation: 'none' }]
        : [],
    };
    const workDir = join(dir, `work-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    const compPath = join(workDir, 'composition.json');
    writeFileSync(compPath, JSON.stringify(comp), 'utf8');
    sign.register('stage:composition.json', compPath);
    const payload = { production_id: 'prod-test', revision: 3, composition: 'stage:composition.json', canvas: CANVAS, handle_seconds: 0.5, output: 'renders/3/preview.mp4' };
    const ctx = {
      job: { id: 'job-text', type: 'studio.render_preview', attempt: 1, ticket: 't', lease_token: 'l', sign_url: 'http://fake/sign', payload, lane: 'interactive' },
      payload, workDir, sign, cache: {} as unknown,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: function () { return this; } },
      signal: new AbortController().signal, progress: () => {},
      download: store.makeDownload(sign), upload: store.makeUpload(), uploadJson: store.makeUploadJson(),
    };
    const { makeStudioRenderPreviewHandler } = await import('../render-handler.js');
    await makeStudioRenderPreviewHandler(extra)(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);
    if (withText) expect(existsSync(join(workDir, 'overlay.ass'))).toBe(true);
    return store.uploaded.get('renders/3/preview.mp4')!.localPath;
  }

  test(
    'subtitle cues and titles show up as light pixels over the footage',
    async () => {
      if (!ffmpegOk) { console.log('ffmpeg not available, skipping'); return; }
      const { findArialFiles } = await import('../fonts.js');
      if (findArialFiles().length === 0) { console.log('Arial not installed here, skipping'); return; }
      const plain = await render(false);
      const texted = await render(true);
      const subtitleBand = 'iw*3/4:ih/5:iw/8:ih*4/5';
      const titleCorner = 'iw/2:ih/4:0:0';
      // blue footage has almost no red; white Arial text adds it where it is drawn
      const redGain = async (crop: string) => (await regionColourAt(texted, 1.5, crop))[0] - (await regionColourAt(plain, 1.5, crop))[0];
      expect(await redGain(subtitleBand)).toBeGreaterThan(8);
      expect(await redGain(titleCorner)).toBeGreaterThan(8);
    },
    180_000,
  );

  test(
    'a machine without Arial fails the job for good, naming the fix',
    async () => {
      if (!ffmpegOk) { console.log('ffmpeg not available, skipping'); return; }
      const empty = join(dir, 'no-fonts');
      mkdirSync(empty, { recursive: true });
      await expect(render(true, { fonts_dir: empty })).rejects.toMatchObject({ code: 'fonts_missing' });
    },
    120_000,
  );
});
