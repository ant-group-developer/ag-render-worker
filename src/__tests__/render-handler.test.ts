/**
 * Test: studio.render_preview / studio.render_final handler.
 *
 * GĐ2: footage là `asset:<id>` (toàn bộ file gốc, không cắt).
 * Tests:
 *   - asset inputs (mock sign + cache + download)
 *   - clamp behaviour khi out > probed duration
 *   - thumbnail path naming (unit)
 *   - thumbnail ffmpeg arg building (unit)
 *   - manifest shape
 *   - integration: 2-clip composition từ 2 video lavfi + 1 thumbnail (skip khi thiếu ffmpeg)
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

// ---- Fake sign server ----

class FakeSignClient {
  private readonly map = new Map<string, string>();

  register(inputName: string, localPath: string): void {
    this.map.set(inputName, localPath);
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
            start_ms: null,
            end_ms: null,
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
      const { copyFileSync } = await import('node:fs');
      mkdirSync(dirname(dest), { recursive: true });
      // For stage:/library: inputs, use the sign client to resolve
      const { url } = await sign.getInput(inputName);
      const localPath = url.startsWith('file://')
        ? url.slice(7).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, process.platform === 'win32' ? '\\' : '/')
        : url;
      copyFileSync(localPath, dest);
    };
  }
}

// ---- Build composition fixture ----

function buildAssetComposition(
  assetInputName: string,
  assetDuration: number,
  narrationWavPath: string,
  canvas: { width: number; height: number },
) {
  return {
    schema_version: 'harness.composition/v1',
    output: { width: canvas.width, height: canvas.height, fps: 25, codec: 'h264' },
    voice: 'tts',
    language: 'vi',
    total_seconds: assetDuration,
    request_id: 'req_01ABCDEFGHJKMNPQRSTVWXYZ12',
    brand: null,
    segments: [
      {
        order: 0,
        source_id: 'src_01ABCDEFGHJKMNPQRSTVWXYZ12',
        source_path: assetInputName,
        in: 0,
        out: assetDuration,
        start: 0,
        end: assetDuration,
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
      { line_id: 'L001', wav: 'stage:tts/L001.wav', start: 0, end: assetDuration },
    ],
    transitions: { requested: 0, applied: 0, downgraded: [] },
    warnings: [],
  };
}

function buildSilentWav(durationSec: number): Buffer {
  const sampleRate = 24000;
  const numSamples = sampleRate * durationSec;
  const wav = Buffer.alloc(44 + numSamples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + numSamples * 2, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(numSamples * 2, 40);
  return wav;
}

// ---- Unit tests: thumbnail naming ----

describe('thumbnailOutputPath', () => {
  test('replaces .mp4 with .thumb-N.jpg', async () => {
    const { thumbnailOutputPath } = await import('@ag-farm/protocol');
    expect(thumbnailOutputPath('renders/ep1/final-att.mp4', 1)).toBe('renders/ep1/final-att.thumb-1.jpg');
    expect(thumbnailOutputPath('renders/ep1/final-att.mp4', 2)).toBe('renders/ep1/final-att.thumb-2.jpg');
    expect(thumbnailOutputPath('renders/ep1/final-att.mp4', 3)).toBe('renders/ep1/final-att.thumb-3.jpg');
  });
});

// ---- Unit tests: thumbnail ffmpeg arg builder ----

describe('buildThumbnailFfmpegArgs', () => {
  test('builds correct args without fontsDir', async () => {
    const { buildThumbnailFfmpegArgs } = await import('../render-handler.js');
    const args = buildThumbnailFfmpegArgs({
      videoPath: '/tmp/episode.mp4',
      t_s: 5.5,
      assPath: '/tmp/thumb.ass',
      fontsDir: null,
      targetWidth: 1280,
      targetHeight: 720,
      outputPath: '/tmp/thumb-1.jpg',
    });
    expect(args).toContain('-ss');
    expect(args).toContain('5.5');
    expect(args).toContain('-frames:v');
    expect(args).toContain('1');
    expect(args).toContain('-q:v');
    expect(args).toContain('2');
    expect(args[args.indexOf('-vf') + 1]).toContain('scale=w=1280:h=720');
    expect(args[args.indexOf('-vf') + 1]).toContain('crop=1280:720');
    expect(args[args.indexOf('-vf') + 1]).toContain('ass=/tmp/thumb.ass');
    expect(args.at(-1)).toBe('/tmp/thumb-1.jpg');
  });

  test('includes fontsdir in ass filter when fontsDir provided', async () => {
    const { buildThumbnailFfmpegArgs } = await import('../render-handler.js');
    const args = buildThumbnailFfmpegArgs({
      videoPath: '/tmp/episode.mp4',
      t_s: 3,
      assPath: '/tmp/thumb.ass',
      fontsDir: '/tmp/fonts',
      targetWidth: 720,
      targetHeight: 1280,
      outputPath: '/tmp/thumb-2.jpg',
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain('fontsdir=/tmp/fonts');
    expect(vf).toContain('crop=720:1280');
  });

  test('portrait: 720x1280 dimensions', async () => {
    const { buildThumbnailFfmpegArgs } = await import('../render-handler.js');
    const args = buildThumbnailFfmpegArgs({
      videoPath: '/v.mp4',
      t_s: 1,
      assPath: '/a.ass',
      fontsDir: null,
      targetWidth: 720,
      targetHeight: 1280,
      outputPath: '/out.jpg',
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain('scale=w=720:h=1280');
    expect(vf).toContain('crop=720:1280');
  });
});

// ---- Unit test: buildThumbnailAss ----

describe('buildThumbnailAss', () => {
  test('generates valid ASS content with the given text', async () => {
    const { buildThumbnailAss } = await import('../render-handler.js');
    const ass = buildThumbnailAss('Tiêu đề tập 1', 1280, 720);
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1280');
    expect(ass).toContain('PlayResY: 720');
    expect(ass).toContain('Arial');
    expect(ass).toContain('Tiêu đề tập 1');
    expect(ass).toContain('Dialogue:');
  });
});

// ---- Integration: render with asset inputs ----

describe('studio.render_preview handler (asset inputs, integration)', () => {
  let testDir: string;
  let sourceVideoPath: string;
  let narrationWavPath: string;
  let sign: FakeSignClient;
  let store: FakeUploadStore;

  const CANVAS = { width: 320, height: 180 };
  const ASSET_DURATION = 3;

  beforeAll(async () => {
    testDir = join(tmpdir(), `render-asset-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });

    try {
      await execFileAsync(FFMPEG, ['-version'], { timeout: 5000 });
    } catch {
      console.log('ffmpeg not available, skipping render integration test');
      return;
    }

    sourceVideoPath = join(testDir, 'asset.mp4');
    await createLavfiVideo(sourceVideoPath, ASSET_DURATION, 320, 180);

    narrationWavPath = join(testDir, 'L001.wav');
    writeFileSync(narrationWavPath, buildSilentWav(ASSET_DURATION));
  }, 30_000);

  beforeEach(() => {
    sign = new FakeSignClient();
    store = new FakeUploadStore();
  });

  test(
    'produces MP4 with correct dimensions from asset: input',
    async () => {
      if (!sourceVideoPath || !existsSync(sourceVideoPath)) {
        console.log('Source video not created (ffmpeg unavailable), skipping');
        return;
      }

      sign.register('asset:asset-001', sourceVideoPath);
      sign.register('stage:tts/L001.wav', narrationWavPath);

      const workDir = join(testDir, `run-${randomUUID()}`);
      mkdirSync(workDir, { recursive: true });

      const comp = buildAssetComposition('asset:asset-001', ASSET_DURATION, narrationWavPath, CANVAS);
      const compositionPath = join(workDir, 'composition.json');
      writeFileSync(compositionPath, JSON.stringify(comp), 'utf8');
      sign.register('stage:renders/1/composition.json', compositionPath);

      const payload = {
        production_id: 'prod-test',
        revision: 1,
        composition: 'stage:renders/1/composition.json',
        canvas: CANVAS,
        output: 'renders/1/preview.mp4',
      };

      const ctx = {
        job: { id: 'job-asset-test', type: 'studio.render_preview', attempt: 1, ticket: 't1', lease_token: 'l1', sign_url: 'http://fake/sign', payload, lane: 'interactive' },
        payload,
        workDir,
        sign,
        cache: null, // no cache: asset handler falls back to workDir download
        log: {
          info: (msg: string, ...args: unknown[]) => { /* silent */ },
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

      const { makeStudioRenderPreviewHandler } = await import('../render-handler.js');
      const handler = makeStudioRenderPreviewHandler({});
      const result = await handler(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);

      expect(result.manifest).toBe('render.json');

      const renderManifest = store.jsonUploads.get('render.json');
      expect(renderManifest).toBeTruthy();

      const { RenderManifestSchema } = await import('@ag-farm/protocol');
      const parsed = RenderManifestSchema.safeParse(renderManifest);
      if (!parsed.success) console.error('Manifest parse error:', parsed.error.message);
      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.production_id).toBe('prod-test');
        expect(parsed.data.revision).toBe(1);
        expect(parsed.data.width).toBe(CANVAS.width);
        expect(parsed.data.height).toBe(CANVAS.height);
        expect(parsed.data.duration_s).toBeGreaterThan(0);
        expect(parsed.data.thumbnails).toEqual([]);
        // sources should list the asset input
        expect(parsed.data.sources.some((s) => s.input === 'asset:asset-001')).toBe(true);
      }

      const uploadedVideo = store.uploaded.get('renders/1/preview.mp4');
      expect(uploadedVideo).toBeTruthy();
      if (uploadedVideo) {
        const probe = await probeVideo(uploadedVideo.localPath);
        expect(probe.width).toBe(CANVAS.width);
        expect(probe.height).toBe(CANVAS.height);
        expect(probe.duration).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});

// ---- Integration: 2-clip composition + 1 thumbnail ----

describe('studio.render_final with 2 asset clips and 1 thumbnail', () => {
  test(
    'renders 2-clip composition and produces thumbnail',
    async () => {
      try { await execFileAsync(FFMPEG, ['-version'], { timeout: 5000 }); } catch {
        console.log('ffmpeg not available, skipping');
        return;
      }

      const dir = join(tmpdir(), `render-final-thumb-${randomUUID()}`);
      mkdirSync(dir, { recursive: true });

      // Create two test videos
      const vid1 = join(dir, 'asset1.mp4');
      const vid2 = join(dir, 'asset2.mp4');
      await Promise.all([
        createLavfiVideo(vid1, 3, 320, 180),
        createLavfiVideo(vid2, 3, 320, 180),
      ]);

      const wavPath = join(dir, 'L001.wav');
      writeFileSync(wavPath, buildSilentWav(6));

      const sign = new FakeSignClient();
      const store = new FakeUploadStore();
      sign.register('asset:asset-clip1', vid1);
      sign.register('asset:asset-clip2', vid2);
      sign.register('stage:tts/L001.wav', wavPath);

      const comp = {
        schema_version: 'harness.composition/v1',
        output: { width: 320, height: 180, fps: 25, codec: 'h264' },
        voice: 'tts',
        language: 'vi',
        total_seconds: 6,
        request_id: 'req_01ABCDEFGHJKMNPQRSTVWXYZ12',
        brand: null,
        segments: [
          {
            order: 0,
            source_id: 'src_01ABCDEFGHJKMNPQRSTVWXYZ12',
            source_path: 'asset:asset-clip1',
            in: 0,
            out: 3,
            start: 0,
            end: 3,
            fit: 'scale_pad',
            has_audio: true,
            transition_out: { kind: 'cut', seconds: 0, tail_available: false },
          },
          {
            order: 1,
            source_id: 'src_01ABCDEFGHJKMNPQRSTVWXYZ13',
            source_path: 'asset:asset-clip2',
            in: 0,
            out: 3,
            start: 3,
            end: 6,
            fit: 'scale_pad',
            has_audio: true,
            transition_out: { kind: 'cut', seconds: 0, tail_available: false },
          },
        ],
        text_events: [],
        captions: { mode: 'none', cues: [] },
        music: null,
        logo: null,
        narration: [{ line_id: 'L001', wav: 'stage:tts/L001.wav', start: 0, end: 6 }],
        transitions: { requested: 0, applied: 0, downgraded: [] },
        warnings: [],
      };

      const workDir = join(dir, 'work');
      mkdirSync(workDir, { recursive: true });
      const compPath = join(workDir, 'composition.json');
      writeFileSync(compPath, JSON.stringify(comp), 'utf8');
      sign.register('stage:composition.json', compPath);

      const payload = {
        production_id: 'prod-final',
        revision: 1,
        composition: 'stage:composition.json',
        canvas: { width: 320, height: 180 },
        output: 'renders/1/final.mp4',
        thumbnails: [{ t_s: 2.0, text: 'Test Thumbnail' }],
      };

      const ctx = {
        job: { id: 'job-final', type: 'studio.render_final', attempt: 1, ticket: 't', lease_token: 'l', sign_url: 'http://fake/sign', payload, lane: 'interactive' },
        payload,
        workDir,
        sign,
        cache: null,
        log: {
          info: () => {},
          warn: (msg: string, ...args: unknown[]) => console.warn('[render-final]', msg, ...args),
          error: (msg: string, ...args: unknown[]) => console.error('[render-final]', msg, ...args),
          debug: () => {},
          child: function() { return this; },
        },
        signal: new AbortController().signal,
        progress: () => {},
        download: store.makeDownload(sign),
        upload: store.makeUpload(),
        uploadJson: store.makeUploadJson(),
      };

      const { makeStudioRenderFinalHandler } = await import('../render-handler.js');
      await makeStudioRenderFinalHandler({})(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);

      // Check video was uploaded
      const video = store.uploaded.get('renders/1/final.mp4');
      expect(video).toBeTruthy();
      if (video) {
        const probe = await probeVideo(video.localPath);
        expect(probe.duration).toBeGreaterThan(4);
      }

      // Check thumbnail was uploaded
      const thumb = store.uploaded.get('renders/1/final.thumb-1.jpg');
      expect(thumb).toBeTruthy();
      if (thumb) {
        expect(existsSync(thumb.localPath)).toBe(true);
        expect(thumb.contentType).toBe('image/jpeg');
      }

      // Check manifest has thumbnail entry
      const manifest = store.jsonUploads.get('render.json') as Record<string, unknown> | undefined;
      expect(manifest).toBeTruthy();
      if (manifest) {
        const thumbs = manifest['thumbnails'] as unknown[];
        expect(Array.isArray(thumbs)).toBe(true);
        expect(thumbs.length).toBe(1);
      }
    },
    180_000,
  );
});

// ---- Unit test: clamp behaviour ----

describe('asset out clamp', () => {
  test(
    'out > probed duration by >0.5s produces a warning in the manifest',
    async () => {
      try { await execFileAsync(FFMPEG, ['-version'], { timeout: 5000 }); } catch {
        console.log('ffmpeg not available, skipping');
        return;
      }

      const dir = join(tmpdir(), `render-clamp-${randomUUID()}`);
      mkdirSync(dir, { recursive: true });

      // 3-second video
      const vid = join(dir, 'asset.mp4');
      await createLavfiVideo(vid, 3, 320, 180);

      const wavPath = join(dir, 'L001.wav');
      writeFileSync(wavPath, buildSilentWav(3));

      const sign = new FakeSignClient();
      const store = new FakeUploadStore();
      sign.register('asset:asset-clamp', vid);
      sign.register('stage:tts/L001.wav', wavPath);

      // Composition says out=5, but video is only 3s → out - probed > 0.5 → warning + clamp
      const comp = {
        schema_version: 'harness.composition/v1',
        output: { width: 320, height: 180, fps: 25, codec: 'h264' },
        voice: 'tts',
        language: 'vi',
        total_seconds: 5,
        request_id: 'req_01ABCDEFGHJKMNPQRSTVWXYZ12',
        brand: null,
        segments: [
          {
            order: 0,
            source_id: 'src_01ABCDEFGHJKMNPQRSTVWXYZ12',
            source_path: 'asset:asset-clamp',
            in: 0,
            out: 5,  // says 5s, but file is only 3s
            start: 0,
            end: 5,
            fit: 'scale_pad',
            has_audio: true,
            transition_out: { kind: 'cut', seconds: 0, tail_available: false },
          },
        ],
        text_events: [],
        captions: { mode: 'none', cues: [] },
        music: null,
        logo: null,
        narration: [{ line_id: 'L001', wav: 'stage:tts/L001.wav', start: 0, end: 5 }],
        transitions: { requested: 0, applied: 0, downgraded: [] },
        warnings: [],
      };

      const workDir = join(dir, 'work');
      mkdirSync(workDir, { recursive: true });
      const compPath = join(workDir, 'composition.json');
      writeFileSync(compPath, JSON.stringify(comp), 'utf8');
      sign.register('stage:composition.json', compPath);

      const warnMessages: string[] = [];
      const payload = {
        production_id: 'prod-clamp',
        revision: 1,
        composition: 'stage:composition.json',
        canvas: { width: 320, height: 180 },
        output: 'renders/clamp/final.mp4',
      };

      const ctx = {
        job: { id: 'job-clamp', type: 'studio.render_preview', attempt: 1, ticket: 't', lease_token: 'l', sign_url: 'http://fake/sign', payload, lane: 'interactive' },
        payload,
        workDir,
        sign,
        cache: null,
        log: {
          info: () => {},
          warn: (msg: string) => { warnMessages.push(msg); },
          error: () => {},
          debug: () => {},
          child: function() { return this; },
        },
        signal: new AbortController().signal,
        progress: () => {},
        download: store.makeDownload(sign),
        upload: store.makeUpload(),
        uploadJson: store.makeUploadJson(),
      };

      const { makeStudioRenderPreviewHandler } = await import('../render-handler.js');
      await makeStudioRenderPreviewHandler({})(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);

      // Warning should have been logged
      const clampWarning = warnMessages.find((w) => w.includes('clamping'));
      expect(clampWarning).toBeTruthy();

      // Manifest should include the warning
      const manifest = store.jsonUploads.get('render.json') as Record<string, unknown> | undefined;
      expect(manifest).toBeTruthy();
      if (manifest) {
        const warnings = manifest['warnings'] as string[];
        expect(warnings.some((w) => w.includes('clamping'))).toBe(true);
      }
    },
    120_000,
  );
});

// ---- clipSourceId stability ----

describe('clipSourceId', () => {
  test('is a valid, per-clip, stable source id', async () => {
    const { clipSourceId } = await import('../render-handler.js');
    const a = clipSourceId('src_01ABCDEFGHJKMNPQRSTVWXYZ12', 1);
    expect(a).toMatch(/^src_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(clipSourceId('src_01ABCDEFGHJKMNPQRSTVWXYZ12', 1)).toBe(a);
    expect(clipSourceId('src_01ABCDEFGHJKMNPQRSTVWXYZ12', 2)).not.toBe(a);
  });
});

// ---- Text and subtitles burnt in with Arial ----

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
    writeFileSync(wavPath, buildSilentWav(3));
  }, 60_000);

  async function render(withText: boolean, extra: Record<string, unknown> = {}): Promise<string> {
    const sign = new FakeSignClient();
    const store = new FakeUploadStore();
    sign.register('asset:asset-blue', blue);
    sign.register('stage:tts/L001.wav', wavPath);
    const comp = {
      schema_version: 'harness.composition/v1',
      output: { width: CANVAS.width, height: CANVAS.height, fps: 25, codec: 'h264' },
      voice: 'tts',
      language: 'vi',
      total_seconds: 3,
      request_id: 'req_01ABCDEFGHJKMNPQRSTVWXYZ12',
      brand: null,
      segments: [
        {
          order: 0,
          source_id: 'src_01ABCDEFGHJKMNPQRSTVWXYZ12',
          source_path: 'asset:asset-blue',
          in: 0,
          out: 4,
          start: 0,
          end: 3,
          fit: 'scale_pad',
          has_audio: false,
          transition_out: { kind: 'cut', seconds: 0, tail_available: false },
        },
      ],
      text_events: withText
        ? [{ id: 'T001', kind: 'title', text: 'TIÊU ĐỀ MMMMMMMM', start: 0, end: 3, position: 'top_left', animation: 'none' }]
        : [],
      captions: withText
        ? { mode: 'burn-in', cues: [{ index: 1, start: 0, end: 3, lines: ['PHỞ BÒ HÀ NỘI MMMMMMMMMMMMMM'], raise_px: 0, words: [] }] }
        : { mode: 'none', cues: [] },
      music: null,
      logo: null,
      narration: [{ line_id: 'L001', wav: 'stage:tts/L001.wav', start: 0, end: 3 }],
      transitions: { requested: 0, applied: 0, downgraded: [] },
      warnings: [],
    };
    const workDir = join(dir, `work-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    const compPath = join(workDir, 'composition.json');
    writeFileSync(compPath, JSON.stringify(comp), 'utf8');
    sign.register('stage:composition.json', compPath);
    const payload = { production_id: 'prod-test', revision: 3, composition: 'stage:composition.json', canvas: CANVAS, output: 'renders/3/preview.mp4' };
    const ctx = {
      job: { id: 'job-text', type: 'studio.render_preview', attempt: 1, ticket: 't', lease_token: 'l', sign_url: 'http://fake/sign', payload, lane: 'interactive' },
      payload, workDir, sign, cache: null,
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
