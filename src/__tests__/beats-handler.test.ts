/**
 * Test: studio.beats handler.
 * - Fake runner và decoder: payload, tải nhạc, job gửi engine, manifest, lỗi.
 * - Python có trên PATH: chạy engines/python/beats.py --dry-run (không cần librosa).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BeatsManifestSchema } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import { makeStudioBeatsHandler } from '../beats-handler.js';
import type { BeatsDecoder, BeatsEngineJob, BeatsRunner } from '../beats-handler.js';
import { createEngineRunner } from '../python-runner.js';

const execFileAsync = promisify(execFile);

const PAYLOAD = {
  production_id: 'prod-001',
  tracks: [
    { track_id: 'one', audio: 'library:studio/projects/p1/music/aaa.m4a' },
    { track_id: 'mix', audio: 'library:studio/projects/p1/music/bbb.m4a', parts: [38] },
  ],
};

const SILENT = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeCtx(workDir: string, payload: unknown, uploads: Map<string, unknown>, downloads: string[]): JobContext {
  return {
    job: { id: 'job-1', type: 'studio.beats', attempt: 1 } as unknown as JobContext['job'],
    payload,
    workDir,
    log: { ...SILENT, child: () => ({ ...SILENT, child: () => SILENT }) } as unknown as JobContext['log'],
    signal: new AbortController().signal,
    progress: () => {},
    download: (async (name: string, dest: string) => {
      downloads.push(name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.alloc(64));
    }) as JobContext['download'],
    uploadJson: (async (output: string, data: unknown) => {
      uploads.set(output, data);
    }) as JobContext['uploadJson'],
  } as unknown as JobContext;
}

const decode: BeatsDecoder = async (_src, dest) => {
  writeFileSync(dest, 'wav');
};

const track = (id: string, bpm: number | null) => ({
  track_id: id, duration_s: 4.2, bpm, beats_per_bar: 4,
  beats: bpm ? [0.02, 0.52, 1.02, 1.52, 2.02, 2.52, 3.02, 3.52] : [], downbeats: bpm ? [0.02, 2.02] : [],
  sections: [{ start: 0, end: 4.2, bpm }],
});

describe('studio.beats handler', () => {
  let workDir: string;
  let uploads: Map<string, unknown>;
  let downloads: string[];

  beforeEach(() => {
    workDir = join(tmpdir(), `beats-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    uploads = new Map();
    downloads = [];
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  test('downloads each track, decodes it, asks the engine with the joined songs, uploads beats.json', async () => {
    let sent: BeatsEngineJob | null = null;
    const runner: BeatsRunner = async (job) => {
      sent = job;
      return { kind: 'ok', result: { engine: 'librosa:0.11.0', tracks: [track('mix', 96), track('one', 120)] } };
    };
    const result = await makeStudioBeatsHandler({ runner, decode })(makeCtx(workDir, PAYLOAD, uploads, downloads));
    expect(downloads).toEqual(PAYLOAD.tracks.map((t) => t.audio));
    expect(sent!.beats_per_bar).toBe(4);
    expect(sent!.items.map((i) => [i.track_id, i.parts])).toEqual([['one', []], ['mix', [38]]]);
    expect(sent!.items[0]!.audio_path).toBe(join(workDir, 'beats', 'one.wav'));
    const manifest = BeatsManifestSchema.parse(uploads.get('beats.json'));
    expect(manifest.tracks.map((t) => [t.track_id, t.bpm])).toEqual([['one', 120], ['mix', 96]]);
    expect(manifest.engine).toEqual({ name: 'librosa:0.11.0', version: null });
    expect(result).toEqual({ manifest: 'beats.json', summary: { tracks: 2, beats: 16, bpm: 120 } });
  });

  test('a bad payload, an unreadable file and an engine contract error are not retried; a crash is', async () => {
    const ok: BeatsRunner = async () => ({ kind: 'ok', result: { engine: 'x', tracks: [track('one', 120), track('mix', null)] } });
    await expect(makeStudioBeatsHandler({ runner: ok, decode })(makeCtx(workDir, { production_id: 'p', tracks: [] }, uploads, downloads)))
      .rejects.toBeInstanceOf(NonRetryableError);
    const broken: BeatsDecoder = async () => { throw new Error('Invalid data found when processing input'); };
    await expect(makeStudioBeatsHandler({ runner: ok, decode: broken })(makeCtx(workDir, PAYLOAD, uploads, downloads)))
      .rejects.toMatchObject({ code: 'audio_invalid' });
    const contract: BeatsRunner = async () => ({ kind: 'contract', reason: 'librosa is not installed' });
    await expect(makeStudioBeatsHandler({ runner: contract, decode })(makeCtx(workDir, PAYLOAD, uploads, downloads)))
      .rejects.toBeInstanceOf(NonRetryableError);
    const crash: BeatsRunner = async () => ({ kind: 'transient', reason: 'python engine exited 1' });
    const e = await makeStudioBeatsHandler({ runner: crash, decode })(makeCtx(workDir, PAYLOAD, uploads, downloads)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(NonRetryableError);
    const short: BeatsRunner = async () => ({ kind: 'ok', result: { engine: 'x', tracks: [track('one', 120)] } });
    await expect(makeStudioBeatsHandler({ runner: short, decode })(makeCtx(workDir, PAYLOAD, uploads, downloads))).rejects.toThrow(/mix/);
  });

  test('with python on PATH: beats.py --dry-run answers through the real runner', async () => {
    let pythonBin: string | null = null;
    for (const bin of ['python', 'python3']) {
      try {
        await execFileAsync(bin, ['--version'], { timeout: 5000 });
        pythonBin = bin;
        break;
      } catch {
        // not found
      }
    }
    if (!pythonBin) return;
    const runner = createEngineRunner({
      pythonBin,
      enginesDir: join(process.cwd(), 'engines', 'python'),
      script: 'beats.py',
      timeoutMs: 30_000,
      dryRun: true,
    }) as BeatsRunner;
    await makeStudioBeatsHandler({ runner, decode })(makeCtx(workDir, PAYLOAD, uploads, downloads));
    const manifest = BeatsManifestSchema.parse(uploads.get('beats.json'));
    expect(manifest.tracks.map((t) => [t.track_id, t.bpm, t.beats.length])).toEqual([['one', null, 0], ['mix', null, 0]]);
    expect(readFileSync(join(workDir, 'beats', 'one.wav'), 'utf8')).toBe('wav');
  });
});
