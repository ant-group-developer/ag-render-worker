/**
 * Handler studio.transcribe: nhận dạng lời nói trong footage bằng WhisperX (engines/python/transcribe.py).
 * Studio gửi sẵn WAV 16 kHz mono của từng nguồn (`stage:audio/<source_id>.wav`), nên máy này không tải video gốc.
 * Output: transcribe.json (TranscribeManifestSchema).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StudioTranscribePayloadSchema,
  TranscribeManifestSchema,
  TRANSCRIBE_MANIFEST_PATH,
  TRANSCRIBE_MANIFEST_SCHEMA,
} from '@ag-farm/protocol';
import type { JobResult, TranscribeManifest } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import type { RenderWorkerExtra } from './config.js';
import { unloadOllamaModels } from './ollama.js';
import { createEngineRunner } from './python-runner.js';
import type { EngineRunResult } from './python-runner.js';
import { resolveTtsDevice } from './tts-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Job của transcribe.py (cùng giao thức với PythonMediaEngine của Studio). */
export interface TranscribeEngineJob {
  device: string;
  model: string;
  compute_type: string;
  batch_size: number;
  items: { source_id: string; audio_path: string; language: string | null }[];
}

type EngineSource = TranscribeManifest['sources'][number];

export interface TranscribeEngineResult {
  engine: string;
  sources: EngineSource[];
}

export type TranscribeRunner = (
  job: TranscribeEngineJob,
  outDir: string,
  signal?: AbortSignal,
) => Promise<EngineRunResult<TranscribeEngineResult>>;

export interface TranscribeHandlerContext {
  runner?: TranscribeRunner;
  extra?: RenderWorkerExtra;
  enginesDir?: string;
}

const DEFAULT_BATCH_SIZE = 8;

/** `float16` trên GPU, `int8` trên CPU (faster-whisper không chạy float16 trên CPU); `extra` ghi đè. */
function computeTypeFor(device: string, configured: string | undefined): string {
  if (configured) return configured;
  return device === 'cpu' ? 'int8' : 'float16';
}

export function makeStudioTranscribeHandler(
  overrides: TranscribeHandlerContext = {},
): (ctx: JobContext) => Promise<JobResult> {
  return async (ctx: JobContext): Promise<JobResult> => {
    const parsed = StudioTranscribePayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new NonRetryableError('invalid_payload', `Invalid studio.transcribe payload: ${parsed.error.message}`);
    }
    const payload = parsed.data;
    const extra: RenderWorkerExtra = overrides.extra ?? {};
    const log = ctx.log.child({ handler: 'studio.transcribe', production_id: payload.production_id });
    log.info('Starting studio.transcribe', { sources: payload.sources.length, model: payload.model });

    ctx.progress(2, 'download');
    const audioDir = join(ctx.workDir, 'audio');
    mkdirSync(audioDir, { recursive: true });
    const items: TranscribeEngineJob['items'] = [];
    for (const [i, source] of payload.sources.entries()) {
      const audioPath = join(audioDir, `${source.source_id}.wav`);
      await ctx.download(source.audio, audioPath);
      items.push({ source_id: source.source_id, audio_path: audioPath, language: source.language });
      ctx.progress(2 + Math.round((18 * (i + 1)) / payload.sources.length), 'download');
    }

    if (extra.unload_ollama_before_tts === true) {
      await unloadOllamaModels(extra.ollama_url ?? 'http://localhost:11434');
    }

    const device = resolveTtsDevice(extra.transcribe_device ?? extra.tts_device);
    const job: TranscribeEngineJob = {
      device,
      model: payload.model,
      compute_type: computeTypeFor(device, extra.transcribe_compute_type),
      batch_size: extra.transcribe_batch_size ?? DEFAULT_BATCH_SIZE,
      items,
    };

    ctx.progress(20, 'transcribe');
    const runner: TranscribeRunner =
      overrides.runner ??
      (createEngineRunner({
        pythonBin: extra.python_bin ?? 'python',
        enginesDir: overrides.enginesDir ?? join(__dirname, '..', 'engines', 'python'),
        script: 'transcribe.py',
        timeoutMs: (extra.python_timeout_s ?? 600) * 1000,
      }) as TranscribeRunner);
    const run = await runner(job, ctx.workDir, ctx.signal);
    if (run.kind === 'contract') {
      throw new NonRetryableError('transcribe_contract_error', `Transcribe engine contract error: ${run.reason}`);
    }
    if (run.kind !== 'ok') throw new Error(`Transcribe engine failed (transient): ${run.reason}`);

    const bySource = new Map(run.result.sources.map((s) => [s.source_id, s]));
    const missing = payload.sources.filter((s) => !bySource.has(s.source_id)).map((s) => s.source_id);
    if (missing.length > 0) throw new Error(`Transcribe engine returned no result for ${missing.join(', ')}`);

    const sources = payload.sources.map((s): EngineSource => {
      const r = bySource.get(s.source_id)!;
      if (payload.align_words) return r;
      return { ...r, alignment: 'segment', segments: r.segments.map((seg) => ({ ...seg, words: [] })) };
    });
    const manifest = TranscribeManifestSchema.parse({
      schema: TRANSCRIBE_MANIFEST_SCHEMA,
      production_id: payload.production_id,
      engine: { name: run.result.engine, version: null },
      sources,
    });

    ctx.progress(95, 'upload_manifest');
    await ctx.uploadJson(TRANSCRIBE_MANIFEST_PATH, manifest);
    const segments = manifest.sources.reduce((n, s) => n + s.segments.length, 0);
    log.info('studio.transcribe done', { sources: manifest.sources.length, segments });
    return { manifest: TRANSCRIBE_MANIFEST_PATH, summary: { sources: manifest.sources.length, segments } };
  };
}
