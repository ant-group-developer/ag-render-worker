/**
 * Test: studio.transcribe handler.
 * - Fake runner: payload, tải WAV, job gửi engine, manifest, lỗi.
 * - Python có trên PATH: chạy engines/python/transcribe.py --dry-run (không cần torch/whisperx).
 */
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TranscribeManifestSchema } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import { makeStudioTranscribeHandler } from '../transcribe-handler.js';
import type { TranscribeEngineJob, TranscribeRunner } from '../transcribe-handler.js';
import { createEngineRunner } from '../python-runner.js';

const execFileAsync = promisify(execFile);

const PAYLOAD = {
  production_id: 'prod-001',
  model: 'large-v3',
  sources: [
    { source_id: 'src_A', audio: 'stage:audio/src_A.wav', language: 'vi' },
    { source_id: 'src_B', audio: 'stage:audio/src_B.wav', language: null },
  ],
  align_words: true,
};

const SILENT = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeCtx(workDir: string, payload: unknown, uploads: Map<string, unknown>, downloads: string[]): JobContext {
  const audioSrc = join(workDir, '..', `fixture-${randomUUID()}.wav`);
  writeFileSync(audioSrc, Buffer.alloc(64));
  return {
    job: { id: 'job-1', type: 'studio.transcribe', attempt: 1 } as unknown as JobContext['job'],
    payload,
    workDir,
    sign: {} as unknown as JobContext['sign'],
    cache: {} as unknown as JobContext['cache'],
    log: { ...SILENT, child: () => ({ ...SILENT, child: () => SILENT }) } as unknown as JobContext['log'],
    signal: new AbortController().signal,
    progress: () => {},
    shouldYield: () => false,
    yieldToInteractive: async () => {},
    download: (async (name: string, dest: string) => {
      downloads.push(name);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(audioSrc, dest);
    }) as JobContext['download'],
    upload: (async (local: string, output: string) => {
      uploads.set(output, readFileSync(local));
    }) as JobContext['upload'],
    uploadJson: (async (output: string, data: unknown) => {
      uploads.set(output, data);
    }) as JobContext['uploadJson'],
  } as unknown as JobContext;
}

function okRunner(seen: TranscribeEngineJob[]): TranscribeRunner {
  return async (job) => {
    seen.push(job);
    return {
      kind: 'ok',
      result: {
        engine: 'whisperx:large-v3',
        sources: job.items.map((item) => ({
          source_id: item.source_id,
          language: item.language ?? 'vi',
          alignment: 'word' as const,
          segments: [
            { start: 0.4, end: 1.6, text: 'Xin chào', words: [{ word: 'Xin', start: 0.4, end: 0.8, score: 0.93 }] },
          ],
        })),
      },
    };
  };
}

describe('studio.transcribe handler', () => {
  let workDir: string;
  let uploads: Map<string, unknown>;
  let downloads: string[];

  beforeEach(() => {
    workDir = join(tmpdir(), `transcribe-test-${randomUUID()}`, 'work');
    mkdirSync(workDir, { recursive: true });
    uploads = new Map();
    downloads = [];
  });

  test('downloads each source, runs the engine once, uploads transcribe.json', async () => {
    const seen: TranscribeEngineJob[] = [];
    const handler = makeStudioTranscribeHandler({ runner: okRunner(seen), extra: { transcribe_device: 'cpu' } });
    const result = await handler(makeCtx(workDir, PAYLOAD, uploads, downloads));

    expect(downloads).toEqual(['stage:audio/src_A.wav', 'stage:audio/src_B.wav']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ device: 'cpu', model: 'large-v3', compute_type: 'int8', batch_size: 8 });
    expect(seen[0]!.items.map((i) => [i.source_id, i.language])).toEqual([['src_A', 'vi'], ['src_B', null]]);
    expect(seen[0]!.items[0]!.audio_path).toBe(join(workDir, 'audio', 'src_A.wav'));

    expect(result.manifest).toBe('transcribe.json');
    expect(result.summary).toEqual({ sources: 2, segments: 2 });
    const manifest = TranscribeManifestSchema.parse(uploads.get('transcribe.json'));
    expect(manifest.production_id).toBe('prod-001');
    expect(manifest.engine).toEqual({ name: 'whisperx:large-v3', version: null });
    expect(manifest.sources[0]!.segments[0]!.words[0]).toEqual({ word: 'Xin', start: 0.4, end: 0.8, score: 0.93 });
  });

  test('a GPU device runs float16 unless the config says otherwise', async () => {
    const seen: TranscribeEngineJob[] = [];
    await makeStudioTranscribeHandler({ runner: okRunner(seen), extra: { transcribe_device: 'cuda' } })(
      makeCtx(workDir, PAYLOAD, uploads, downloads),
    );
    await makeStudioTranscribeHandler({
      runner: okRunner(seen),
      extra: { transcribe_device: 'cuda', transcribe_compute_type: 'int8_float16', transcribe_batch_size: 4 },
    })(makeCtx(workDir, PAYLOAD, uploads, downloads));
    expect(seen.map((j) => [j.device, j.compute_type, j.batch_size])).toEqual([
      ['cuda', 'float16', 8],
      ['cuda', 'int8_float16', 4],
    ]);
  });

  test('align_words: false keeps sentence timings only', async () => {
    const handler = makeStudioTranscribeHandler({ runner: okRunner([]), extra: { transcribe_device: 'cpu' } });
    await handler(makeCtx(workDir, { ...PAYLOAD, align_words: false }, uploads, downloads));
    const manifest = TranscribeManifestSchema.parse(uploads.get('transcribe.json'));
    expect(manifest.sources.every((s) => s.alignment === 'segment')).toBe(true);
    expect(manifest.sources[0]!.segments[0]!.words).toEqual([]);
  });

  test('an invalid payload is not retried', async () => {
    const handler = makeStudioTranscribeHandler({ runner: okRunner([]) });
    await expect(handler(makeCtx(workDir, { ...PAYLOAD, sources: [] }, uploads, downloads))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  test('an engine contract error is not retried, a transient one is', async () => {
    const contract = makeStudioTranscribeHandler({ runner: async () => ({ kind: 'contract', reason: 'whisperx missing' }) });
    await expect(contract(makeCtx(workDir, PAYLOAD, uploads, downloads))).rejects.toBeInstanceOf(NonRetryableError);
    const transient = makeStudioTranscribeHandler({ runner: async () => ({ kind: 'transient', reason: 'CUDA OOM' }) });
    const err = await transient(makeCtx(workDir, PAYLOAD, uploads, downloads)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(String(err)).toContain('CUDA OOM');
  });

  test('an engine result that does not name every source is rejected', async () => {
    const handler = makeStudioTranscribeHandler({
      runner: async () => ({ kind: 'ok', result: { engine: 'whisperx:large-v3', sources: [] } }),
    });
    await expect(handler(makeCtx(workDir, PAYLOAD, uploads, downloads))).rejects.toThrow(/src_A/);
  });

  test('with python on PATH: transcribe.py --dry-run answers through the real runner', async () => {
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
      script: 'transcribe.py',
      timeoutMs: 30_000,
      dryRun: true,
    }) as TranscribeRunner;
    const handler = makeStudioTranscribeHandler({ runner, extra: { transcribe_device: 'cpu' } });
    await handler(makeCtx(workDir, PAYLOAD, uploads, downloads));
    const manifest = TranscribeManifestSchema.parse(uploads.get('transcribe.json'));
    expect(manifest.sources.map((s) => s.source_id)).toEqual(['src_A', 'src_B']);
  });
});
