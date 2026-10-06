/**
 * Tests: studio.export_premiere handler.
 *
 * Covers:
 *   - Payload validation rejects invalid payloads
 *   - Handler with mocks: produces zip, uploads it, uploads premiere.json manifest
 *   - Manifest shape validates against PremiereManifestSchema
 *   - One real ffmpeg overlay PNG test (skipped when ffmpeg-static not present)
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const _require = createRequire(import.meta.url);

// ---- Resolve ffmpeg ----

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

// ---- Simple composition fixture for export ----

function buildExportComposition(
  assetInputName: string,
  durationS: number,
  canvas: { width: number; height: number },
  withText = false,
) {
  return {
    schema_version: 'harness.composition/v1',
    output: { width: canvas.width, height: canvas.height, fps: 25, codec: 'h264' },
    voice: 'none',
    language: 'vi',
    total_seconds: durationS,
    request_id: 'req_01ABCDEFGHJKMNPQRSTVWXYZ12',
    brand: null,
    segments: [
      {
        order: 0,
        source_id: 'src_01ABCDEFGHJKMNPQRSTVWXYZ12',
        source_path: assetInputName,
        in: 0,
        out: durationS,
        start: 0,
        end: durationS,
        fit: 'scale_pad',
        has_audio: true,
        transition_out: { kind: 'cut', seconds: 0, tail_available: false },
      },
    ],
    text_events: withText
      ? [{ id: 'T001', kind: 'title', text: 'Tiêu đề test', start: 0, end: durationS, position: 'top_left', animation: 'none' }]
      : [],
    captions: { mode: 'none', cues: [] },
    music: null,
    logo: null,
    narration: [],
    transitions: { requested: 0, applied: 0, downgraded: [] },
    warnings: [],
  };
}

// ---- Fake infrastructure ----

class FakeSignClient {
  private readonly map = new Map<string, string>();
  register(name: string, path: string) { this.map.set(name, path); }

  async sign(ops: Array<{ op: string; input?: string }>): Promise<unknown[]> {
    return ops.map((op) => {
      if (op.op === 'get' && op.input) {
        const p = this.map.get(op.input);
        if (!p) throw new Error(`Unknown input: ${op.input}`);
        return {
          op: 'get', input: op.input,
          url: `file://${p.replace(/\\/g, '/')}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          size_bytes: null, content_type: 'video/mp4', cache_key: null,
          source: { source_kind: 'original', watermarked: false, start_ms: null, end_ms: null },
        };
      }
      throw new Error(`Unhandled op: ${op.op}`);
    });
  }

  async getInput(name: string) {
    const p = this.map.get(name);
    if (!p) throw new Error(`Unknown: ${name}`);
    return {
      url: `file://${p.replace(/\\/g, '/')}`,
      expiresAt: new Date(Date.now() + 3600_000),
      sizeBytes: null, cacheKey: null,
    };
  }
}

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
      mkdirSync(dirname(dest), { recursive: true });
      const { url } = await sign.getInput(inputName);
      const localPath = url.startsWith('file://')
        ? url.slice(7).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, process.platform === 'win32' ? '\\' : '/')
        : url;
      const { copyFileSync } = await import('node:fs');
      copyFileSync(localPath, dest);
    };
  }
}

function buildFakeCtx(
  workDir: string,
  payload: unknown,
  sign: FakeSignClient,
  store: FakeUploadStore,
) {
  return {
    job: { id: 'job-premiere', type: 'studio.export_premiere', attempt: 1, ticket: 't', lease_token: 'l', sign_url: 'http://fake/sign', payload, lane: 'interactive' },
    payload,
    workDir,
    sign,
    cache: null,
    log: {
      info: () => {},
      warn: (msg: string, ...a: unknown[]) => { /* console.warn(msg, ...a); */ },
      error: (msg: string, ...a: unknown[]) => console.error('[premiere]', msg, ...a),
      debug: () => {},
      child: function () { return this; },
    },
    signal: new AbortController().signal,
    progress: () => {},
    download: store.makeDownload(sign),
    upload: store.makeUpload(),
    uploadJson: store.makeUploadJson(),
  };
}

// ---- Minimal MP4 (8 bytes, not real video but good enough for mocked probe-free test) ----

function buildMinimalMp4(): Buffer {
  // Not a real MP4 — only used in tests where we don't probe
  return Buffer.alloc(1024, 0);
}

// ---- Unit: payload validation ----

describe('StudioExportPremierePayloadSchema', () => {
  test('rejects a missing output field', async () => {
    const { StudioExportPremierePayloadSchema } = await import('@ag-farm/protocol');
    const result = StudioExportPremierePayloadSchema.safeParse({
      production_id: 'p1',
      episode_id: 'ep1',
      composition: 'stage:comp.json',
      media: 'proxy',
      name: 'Test',
      // output missing
    });
    expect(result.success).toBe(false);
  });

  test('accepts a valid payload', async () => {
    const { StudioExportPremierePayloadSchema } = await import('@ag-farm/protocol');
    const result = StudioExportPremierePayloadSchema.safeParse({
      production_id: 'p1',
      episode_id: 'ep1',
      composition: 'stage:comp.json',
      media: 'original',
      name: 'Tập 1 — Khởi đầu',
      markers: [{ t_s: 0, title: 'Intro' }],
      output: 'episodes/ep1/premiere/job-001.zip',
    });
    expect(result.success).toBe(true);
  });

  test('rejects name longer than 200 chars', async () => {
    const { StudioExportPremierePayloadSchema } = await import('@ag-farm/protocol');
    const result = StudioExportPremierePayloadSchema.safeParse({
      production_id: 'p1',
      episode_id: 'ep1',
      composition: 'stage:comp.json',
      media: 'proxy',
      name: 'x'.repeat(201),
      output: 'episodes/ep1/premiere/job-001.zip',
    });
    expect(result.success).toBe(false);
  });
});

// ---- Unit: PremiereManifestSchema ----

describe('PremiereManifestSchema', () => {
  test('validates a correct manifest', async () => {
    const { PremiereManifestSchema, PREMIERE_MANIFEST_SCHEMA } = await import('@ag-farm/protocol');
    const result = PremiereManifestSchema.safeParse({
      schema: PREMIERE_MANIFEST_SCHEMA,
      output: 'episodes/ep1/premiere/job-001.zip',
      size_bytes: 1024 * 1024,
      media: 'proxy',
      files: [
        { path: 'media/01-clip.mp4', size_bytes: 500_000, source_kind: 'proxy', watermarked: false },
      ],
      warnings: [],
    });
    expect(result.success).toBe(true);
  });
});

// ---- Integration: handler with mocks (ffmpeg-based) ----

describe('studio.export_premiere handler (mocked, with ffmpeg)', () => {
  let testDir: string;
  let assetVideoPath: string;
  let ffmpegOk = false;

  const CANVAS = { width: 320, height: 180 };

  beforeAll(async () => {
    try {
      await execFileAsync(FFMPEG, ['-version'], { timeout: 5000 });
      ffmpegOk = true;
    } catch {
      console.log('ffmpeg not available, some tests will be skipped');
    }

    testDir = join(tmpdir(), `premiere-handler-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });

    if (ffmpegOk) {
      assetVideoPath = join(testDir, 'asset.mp4');
      // Create a real short video with lavfi
      await execFileAsync(FFMPEG, [
        '-f', 'lavfi', '-i', `testsrc2=size=${CANVAS.width}x${CANVAS.height}:rate=25:duration=3`,
        '-f', 'lavfi', '-i', 'aevalsrc=0:c=mono:s=48000:d=3',
        '-c:v', 'libx264', '-crf', '40', '-preset', 'ultrafast',
        '-c:a', 'aac', '-t', '3', '-y', assetVideoPath,
      ], { timeout: 30_000 });
    }
  }, 60_000);

  test('produces a zip file and uploads premiere.json when ffmpeg is available', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }

    const sign = new FakeSignClient();
    const store = new FakeUploadStore();

    const workDir = join(testDir, `run-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });

    sign.register('asset:clip-001', assetVideoPath);

    const comp = buildExportComposition('asset:clip-001', 3, CANVAS);
    const compPath = join(workDir, 'composition.json');
    writeFileSync(compPath, JSON.stringify(comp), 'utf8');
    sign.register('stage:comp.json', compPath);

    const payload = {
      production_id: 'prod-test',
      episode_id: 'ep-001',
      composition: 'stage:comp.json',
      media: 'proxy',
      name: 'Test Episode',
      markers: [{ t_s: 0, title: 'Intro' }, { t_s: 1.5, title: 'Main' }],
      media_names: { 'asset:clip-001': 'Chợ nổi Cái Răng – Đà Lạt' },
      output: 'episodes/ep-001/premiere/job-001.zip',
    };

    const ctx = buildFakeCtx(workDir, payload, sign, store);

    const { makeStudioExportPremiereHandler } = await import('../premiere-handler.js');
    const result = await makeStudioExportPremiereHandler({})(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);

    // Check result manifest path
    expect(result.manifest).toBe('premiere.json');

    // Check that the zip was uploaded
    const zipEntry = store.uploaded.get('episodes/ep-001/premiere/job-001.zip');
    expect(zipEntry).toBeTruthy();
    expect(zipEntry?.contentType).toBe('application/zip');

    // Check the zip file exists and has non-zero size
    if (zipEntry) {
      const { statSync } = await import('node:fs');
      const stat = statSync(zipEntry.localPath);
      expect(stat.size).toBeGreaterThan(100);
    }

    // Check premiere.json was uploaded
    const premiereJson = store.jsonUploads.get('premiere.json');
    expect(premiereJson).toBeTruthy();

    // Validate manifest shape
    const { PremiereManifestSchema } = await import('@ag-farm/protocol');
    const parsed = PremiereManifestSchema.safeParse(premiereJson);
    if (!parsed.success) console.error('Manifest error:', parsed.error.message);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.media).toBe('proxy');
      expect(parsed.data.files.length).toBeGreaterThan(0);
      expect(parsed.data.output).toBe('episodes/ep-001/premiere/job-001.zip');
      // The media file is named after the video, not its id
      expect(parsed.data.files.map((f) => f.path)).toContain('media/01-Cho_noi_Cai_Rang_Da_Lat.mp4');
    }
  }, 120_000);

  /** Runs the handler on `comp` (one 3 s clip with sound, `asset:clip-001`) and returns the project.xml it built. */
  async function exportXml(comp: ReturnType<typeof buildExportComposition>, extraInputs: Record<string, string> = {}): Promise<string> {
    const sign = new FakeSignClient();
    const store = new FakeUploadStore();
    const workDir = join(testDir, `run-xml-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    sign.register('asset:clip-001', assetVideoPath);
    for (const [name, path] of Object.entries(extraInputs)) sign.register(name, path);
    const compPath = join(workDir, 'composition.json');
    writeFileSync(compPath, JSON.stringify(comp), 'utf8');
    sign.register('stage:comp.json', compPath);
    const payload = {
      production_id: 'prod-xml', episode_id: 'ep-xml', composition: 'stage:comp.json', media: 'proxy',
      name: 'XML Test', markers: [], output: 'episodes/ep-xml/premiere/job.zip',
    };
    const ctx = buildFakeCtx(workDir, payload, sign, store);
    const { makeStudioExportPremiereHandler } = await import('../premiere-handler.js');
    await makeStudioExportPremiereHandler({})(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);
    return readFileSync(join(workDir, 'project.xml'), 'utf8');
  }

  test('A1 carries the videos\' sound when the composition keeps it', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const xml = await exportXml(buildExportComposition('asset:clip-001', 3, CANVAS));
    expect(xml).toContain('id="clipitem-a1"');
  }, 120_000);

  test('A1 is empty when the composition mutes the source audio (segments[].has_audio=false)', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const comp = buildExportComposition('asset:clip-001', 3, CANVAS);
    comp.segments = comp.segments.map((s) => ({ ...s, has_audio: false }));
    const xml = await exportXml(comp);
    expect(xml).not.toContain('clipitem-a');
    // The video stays on V1 and is no longer linked to a sound clip.
    expect(xml).toContain('id="clipitem-v1"');
    expect(xml).not.toContain('<linkclipref>');
  }, 120_000);

  test('slugify drops Vietnamese marks and falls back to the id', async () => {
    const { slugify } = await import('../premiere-handler.js');
    expect(slugify('Chợ nổi Cái Răng – Đà Lạt')).toBe('Cho_noi_Cai_Rang_Da_Lat');
    expect(slugify('asset:0194f7c2-7a11')).toBe('0194f7c2-7a11');
    expect(slugify('???')).toBe('clip');
  });

  // ---- Real ffmpeg overlay PNG test ----

  test('renders a transparent overlay PNG with correct alpha channel', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }

    const { findArialFiles } = await import('../fonts.js');
    if (findArialFiles().length === 0) {
      console.log('skipping: Arial not installed on this machine');
      return;
    }

    const sign = new FakeSignClient();
    const store = new FakeUploadStore();

    const workDir = join(testDir, `run-overlay-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });

    sign.register('asset:clip-001', assetVideoPath);

    // Composition WITH a text event
    const comp = buildExportComposition('asset:clip-001', 3, CANVAS, true);
    const compPath = join(workDir, 'composition.json');
    writeFileSync(compPath, JSON.stringify(comp), 'utf8');
    sign.register('stage:comp.json', compPath);

    const payload = {
      production_id: 'prod-overlay',
      episode_id: 'ep-002',
      composition: 'stage:comp.json',
      media: 'proxy',
      name: 'Overlay Test',
      markers: [],
      output: 'episodes/ep-002/premiere/job-002.zip',
    };

    const ctx = buildFakeCtx(workDir, payload, sign, store);

    const { makeStudioExportPremiereHandler } = await import('../premiere-handler.js');
    await makeStudioExportPremiereHandler({})(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);

    // Check the overlay PNG was written and has an alpha channel
    const overlaysDir = join(workDir, 'overlays');
    const pngPath = join(overlaysDir, 'T001.png');
    expect(existsSync(pngPath)).toBe(true);

    // Probe the PNG with ffprobe to confirm rgba pixel format
    const { stdout } = await execFileAsync(FFMPEG, [
      '-v', 'quiet',
      '-i', pngPath,
      '-vf', 'format=rgba',
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-',
    ], { encoding: 'buffer', timeout: 10_000 });
    // RGBA: 4 bytes per pixel, 320 * 180 = 57600 pixels = 230400 bytes
    expect(stdout.length).toBe(CANVAS.width * CANVAS.height * 4);

    // Check alpha channel: at least some pixels should have alpha = 0 (transparent background)
    let hasTransparentPixel = false;
    for (let i = 3; i < stdout.length; i += 4) {
      if (stdout[i] === 0) { hasTransparentPixel = true; break; }
    }
    expect(hasTransparentPixel).toBe(true);
  }, 120_000);
});
