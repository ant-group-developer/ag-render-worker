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
  let musicPath: string;
  let voicePath: string;
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
      musicPath = join(testDir, 'music.wav');
      await execFileAsync(FFMPEG, [
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-y', musicPath,
      ], { timeout: 30_000 });
      voicePath = join(testDir, 'L001.wav');
      await execFileAsync(FFMPEG, [
        '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=1', '-y', voicePath,
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
    return (await exportRun(comp, extraInputs)).xml;
  }

  /** Same, also returning the work dir and the uploaded premiere.json. */
  async function exportRun(comp: unknown, extraInputs: Record<string, string> = {}, payloadExtra: Record<string, unknown> = {}) {
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
      name: 'XML Test', markers: [], output: 'episodes/ep-xml/premiere/job.zip', ...payloadExtra,
    };
    const ctx = buildFakeCtx(workDir, payload, sign, store);
    const { makeStudioExportPremiereHandler } = await import('../premiere-handler.js');
    await makeStudioExportPremiereHandler({})(ctx as unknown as import('@ag-farm/worker-sdk').JobContext);
    return {
      xml: readFileSync(join(workDir, 'project.xml'), 'utf8'),
      workDir,
      manifest: store.jsonUploads.get('premiere.json') as { files: { path: string }[]; warnings: string[] },
    };
  }

  /** The direct children of one clipitem/transitionitem, by tag. */
  function item(xml: string, re: RegExp): Record<string, string> {
    const body = xml.match(re)?.[1] ?? '';
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/^ {12}<(\w+)>([^<]*)<\/\1>/gm)) out[m[1]!] ??= m[2]!;
    return out;
  }
  const clipitem = (xml: string, id: string) => item(xml, new RegExp(`<clipitem id="${id}">([\\s\\S]*?)</clipitem>`));

  /** What `timelineToComposition` sends for a shot-cut episode: three shots of the one 3 s video, a dissolve, a
   * dip to black, one narration line with its subtitle, and music ducked under it. */
  function cutComposition() {
    const base = buildExportComposition('asset:clip-001', 2.4, CANVAS);
    const seg = base.segments[0]!;
    return {
      ...base,
      voice: 'tts',
      segments: [
        { ...seg, order: 0, in: 0.4, out: 1.2, start: 0, end: 0.8, transition_out: { kind: 'dissolve', seconds: 0.4, tail_available: true } },
        { ...seg, order: 1, in: 1.6, out: 2.4, start: 0.8, end: 1.6, transition_out: { kind: 'dip_black', seconds: 0.4, tail_available: false } },
        { ...seg, order: 2, in: 0, out: 0.8, start: 1.6, end: 2.4, transition_out: { kind: 'cut', seconds: 0.4, tail_available: false } },
      ],
      narration: [{ line_id: 'L001', wav: 'stage:voice/L001.wav', start: 0.3, end: 1.3 }],
      captions: { mode: 'burn-in', cues: [{ index: 1, start: 0.3, end: 1.3, lines: ['Chợ nổi'], raise_px: 0, words: [] }] },
      music: {
        track_id: '01MUSIC', path: 'stage:music.wav', loop: true, fade_in: 0, fade_out: 0,
        cues: [{ start: 0, end: 2.4, gain_db: -18 }],
        duck: { windows: [{ start: 0.3, end: 1.3 }], gain_db: -8, attack_ms: 200, release_ms: 500 },
      },
      transitions: { requested: 2, applied: 2, downgraded: [] },
    };
  }

  test('a shot-cut episode: clips play their in/out of the one file, with the dissolve and the dip on V1', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const { xml } = await exportRun(cutComposition(), { 'stage:voice/L001.wav': voicePath, 'stage:music.wav': musicPath });
    // 25 fps: shots [10,30) [40,60) [0,20) of the 75-frame file at 0, 20, 40 of the sequence.
    expect(clipitem(xml, 'clipitem-v1')).toMatchObject({ start: '0', end: '-1', in: '10', out: '30', duration: '75' });
    expect(clipitem(xml, 'clipitem-v2')).toMatchObject({ start: '-1', end: '-1', in: '40', out: '60' });
    expect(clipitem(xml, 'clipitem-v3')).toMatchObject({ start: '-1', end: '60', in: '0', out: '20' });
    expect(xml.match(/<file id="[^"]+">/g)?.filter((f) => f.includes('src_'))).toHaveLength(1);
    const transitions = [...xml.matchAll(/<transitionitem>([\s\S]*?)<\/transitionitem>/g)].map((m) => m[1]!);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatch(/<start>20<\/start>\s*<end>30<\/end>\s*<alignment>start<\/alignment>[\s\S]*Cross Dissolve/);
    expect(transitions[1]).toMatch(/<start>35<\/start>\s*<end>45<\/end>\s*<alignment>center<\/alignment>[\s\S]*Dip to Color Dissolve/);
  }, 120_000);

  test('a tts episode: no source sound, the narration on A3, the music ducked under it', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const { xml, manifest } = await exportRun(cutComposition(), { 'stage:voice/L001.wav': voicePath, 'stage:music.wav': musicPath });
    // The render plays only the narration when the voice is tts, even though the segments keep has_audio.
    expect(xml).not.toContain('clipitem-a');
    // 0.3 s → frame 8; the 1 s WAV is 25 frames.
    expect(clipitem(xml, 'clipitem-n1')).toMatchObject({ start: '8', end: '33', in: '0', out: '25' });
    expect(xml).toContain('<pathurl>media/voice-L001.wav</pathurl>');
    expect(manifest.files.map((f) => f.path)).toContain('media/voice-L001.wav');
    // -18 dB = 0.12589, ducked by -8 dB = 0.05012 from frame 8 (+5 attack) to 33 (+13 release).
    const kf = [...(xml.match(/<clipitem id="clipitem-m1">([\s\S]*?)<\/clipitem>/)?.[1] ?? '').matchAll(/<when>(\d+)<\/when>\s*<value>([\d.]+)<\/value>/g)]
      .map((m) => [Number(m[1]), Number(m[2])]);
    expect(kf).toEqual([[0, 0.12589], [8, 0.12589], [13, 0.05012], [33, 0.05012], [46, 0.12589], [50, 0.12589]]);
  }, 120_000);

  test('subtitles go in the zip as captions.srt', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const { workDir } = await exportRun(cutComposition(), { 'stage:voice/L001.wav': voicePath, 'stage:music.wav': musicPath });
    expect(readFileSync(join(workDir, 'captions.srt'), 'utf8')).toBe('1\n00:00:00,300 --> 00:00:01,300\nChợ nổi\n');
  }, 120_000);

  test('a whole-video episode plays each file from start to end, with no captions.srt', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const { xml, workDir } = await exportRun(buildExportComposition('asset:clip-001', 3, CANVAS));
    expect(clipitem(xml, 'clipitem-v1')).toMatchObject({ start: '0', end: '75', in: '0', out: '75', duration: '75' });
    expect(xml).not.toContain('<transitionitem>');
    expect(existsSync(join(workDir, 'captions.srt'))).toBe(false);
  }, 120_000);

  test('A1 carries the videos\' sound when the composition keeps it', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const xml = await exportXml(buildExportComposition('asset:clip-001', 3, CANVAS));
    expect(xml).toContain('id="clipitem-a1"');
  }, 120_000);

  test('A1 sits at -12 dB when the composition has voice "none", as the render mixes it', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const xml = await exportXml(buildExportComposition('asset:clip-001', 3, CANVAS));
    const a1 = xml.match(/<clipitem id="clipitem-a1">([\s\S]*?)<\/clipitem>/)?.[1] ?? '';
    expect(a1).toContain('<value>0.25119</value>');
  }, 120_000);

  test('A1 keeps 0 dB when the composition has voice "original"', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const xml = await exportXml({ ...buildExportComposition('asset:clip-001', 3, CANVAS), voice: 'original' });
    expect(xml).toContain('id="clipitem-a1"');
    expect(xml).not.toContain('<name>Audio Levels</name>');
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

  test('Studio cut 1.1.0: a clip muted on its own has no sound under it on A1; the others keep theirs', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const comp = { ...cutComposition(), voice: 'none', narration: [], captions: { mode: 'none', cues: [] }, music: null };
    comp.segments = comp.segments.map((s, i) => (i === 1 ? { ...s, has_audio: false } : s));
    const { xml } = await exportRun(comp, {}, { edit_style: 'cut', audio: 'per_segment' });
    expect(xml).toContain('id="clipitem-a1"');
    expect(xml).not.toContain('id="clipitem-a2"');
    expect(xml).toContain('id="clipitem-a3"');
  }, 120_000);

  test('Studio cut 1.1.0: the text overlays are drawn in the composition\'s text look', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    const { findArialFiles } = await import('../fonts.js');
    if (findArialFiles().length === 0) { console.log('skipping: Arial not installed on this machine'); return; }
    const look = { text_color: '#FFD166', outline_color: '#000000', box_color: '#1D3557', size: 'm' };
    const { workDir } = await exportRun({ ...buildExportComposition('asset:clip-001', 3, CANVAS, true), text_style: look });
    const ass = readFileSync(join(workDir, 'overlay-T001.ass'), 'utf8');
    const title = ass.split('\n').find((l) => l.startsWith('Style: Title,'))!.split(',');
    expect(title[3]).toBe('&H0066D1FF');
    expect(title[5]).toBe(title[6]);
    expect(existsSync(join(workDir, 'overlays', 'T001.png'))).toBe(true);
  }, 120_000);

  test('A2 takes the music level and fades from the composition', async () => {
    if (!ffmpegOk) { console.log('skipping: ffmpeg not available'); return; }
    // What `timelineToComposition` sends: 3 s episode, 2 s track looped, -18 dB, fade in 1 s, fade out 2 s.
    const comp = {
      ...buildExportComposition('asset:clip-001', 3, CANVAS),
      music: {
        track_id: '01MUSIC', path: 'stage:music.wav', loop: true, fade_in: 1, fade_out: 2,
        cues: [{ start: 0, end: 3, gain_db: -18 }],
        duck: { windows: [], gain_db: -8, attack_ms: 200, release_ms: 500 },
      },
    };
    const xml = await exportXml(comp as unknown as ReturnType<typeof buildExportComposition>, { 'stage:music.wav': musicPath });
    const clip = (id: string) => xml.match(new RegExp(`<clipitem id="${id}">([\\s\\S]*?)</clipitem>`))?.[1] ?? '';
    const kf = (id: string) => [...clip(id).matchAll(/<when>(\d+)<\/when>\s*<value>([\d.]+)<\/value>/g)]
      .map((m) => [Number(m[1]), Number(m[2])]);
    // 75 frames at 25 fps: m1 [0,50), m2 [50,75). -18 dB = 0.12589; fade-in to frame 25, fade-out from frame 25.
    expect(clip('clipitem-m1')).toContain('<value>0.12589</value>');
    expect(kf('clipitem-m1')).toEqual([[0, 0], [25, 0.12589], [50, 0.06295]]);
    expect(kf('clipitem-m2')).toEqual([[0, 0.06295], [25, 0]]);
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
