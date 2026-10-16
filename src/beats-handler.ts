/**
 * Handler studio.beats: nhịp của nhạc nền (engines/python/beats.py, librosa), để Studio cắt cảnh đúng phách hoặc đầu ô
 * nhịp (kế hoạch feedback-vps 2026-10-15 §4.7). Mỗi track tải về, ffmpeg đổi thành WAV mono 22,05 kHz (soundfile không đọc
 * AAC), rồi engine tìm phách. Output: beats.json (BeatsManifestSchema).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEATS_MANIFEST_PATH, BEATS_MANIFEST_SCHEMA, BeatsManifestSchema, StudioBeatsPayloadSchema } from '@ag-farm/protocol';
import type { BeatsManifest, JobResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import type { RenderWorkerExtra } from './config.js';
import { resolveFfmpeg, runFfmpeg } from './ffmpeg-utils.js';
import { createEngineRunner } from './python-runner.js';
import type { EngineRunResult } from './python-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Job của beats.py. */
export interface BeatsEngineJob {
  beats_per_bar: number;
  items: { track_id: string; audio_path: string; parts: number[] }[];
}

export interface BeatsEngineResult {
  engine: string;
  tracks: BeatsManifest['tracks'];
}

export type BeatsRunner = (job: BeatsEngineJob, outDir: string, signal?: AbortSignal) => Promise<EngineRunResult<BeatsEngineResult>>;

/** Đổi file nhạc tải về thành WAV mono mà beats.py đọc. */
export type BeatsDecoder = (src: string, dest: string, signal?: AbortSignal) => Promise<void>;

export interface BeatsHandlerContext {
  runner?: BeatsRunner;
  decode?: BeatsDecoder;
  extra?: RenderWorkerExtra;
  enginesDir?: string;
}

const decodeWithFfmpeg: BeatsDecoder = (src, dest, signal) =>
  runFfmpeg(resolveFfmpeg(), ['-hide_banner', '-y', '-i', src, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', dest], {
    timeoutMs: 10 * 60_000,
    ...(signal ? { signal } : {}),
  });

export function makeStudioBeatsHandler(overrides: BeatsHandlerContext = {}): (ctx: JobContext) => Promise<JobResult> {
  return async (ctx: JobContext): Promise<JobResult> => {
    const parsed = StudioBeatsPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new NonRetryableError('invalid_payload', `Invalid studio.beats payload: ${parsed.error.message}`);
    }
    const payload = parsed.data;
    const extra: RenderWorkerExtra = overrides.extra ?? {};
    const log = ctx.log.child({ handler: 'studio.beats', production_id: payload.production_id });
    log.info('Starting studio.beats', { tracks: payload.tracks.length });

    const dir = join(ctx.workDir, 'beats');
    mkdirSync(dir, { recursive: true });
    const decode = overrides.decode ?? decodeWithFfmpeg;
    const items: BeatsEngineJob['items'] = [];
    for (const [i, track] of payload.tracks.entries()) {
      const src = join(dir, `${track.track_id}.src`);
      const wav = join(dir, `${track.track_id}.wav`);
      await ctx.download(track.audio, src);
      try {
        await decode(src, wav, ctx.signal);
      } catch (e) {
        throw new NonRetryableError('audio_invalid', `Không đọc được nhạc ${track.track_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      items.push({ track_id: track.track_id, audio_path: wav, parts: track.parts });
      ctx.progress(5 + Math.round((25 * (i + 1)) / payload.tracks.length), 'download');
    }

    ctx.progress(30, 'beats');
    const runner: BeatsRunner =
      overrides.runner ??
      (createEngineRunner({
        pythonBin: extra.python_bin ?? 'python',
        enginesDir: overrides.enginesDir ?? join(__dirname, '..', 'engines', 'python'),
        script: 'beats.py',
        timeoutMs: (extra.python_timeout_s ?? 600) * 1000,
      }) as BeatsRunner);
    const run = await runner({ beats_per_bar: payload.beats_per_bar, items }, ctx.workDir, ctx.signal);
    if (run.kind === 'contract') throw new NonRetryableError('beats_contract_error', `Beats engine contract error: ${run.reason}`);
    if (run.kind !== 'ok') throw new Error(`Beats engine failed (transient): ${run.reason}`);

    const byTrack = new Map(run.result.tracks.map((t) => [t.track_id, t]));
    const missing = payload.tracks.filter((t) => !byTrack.has(t.track_id)).map((t) => t.track_id);
    if (missing.length > 0) throw new Error(`Beats engine returned no result for ${missing.join(', ')}`);
    const manifest = BeatsManifestSchema.parse({
      schema: BEATS_MANIFEST_SCHEMA,
      production_id: payload.production_id,
      engine: { name: run.result.engine, version: null },
      tracks: payload.tracks.map((t) => byTrack.get(t.track_id)!),
    });

    ctx.progress(95, 'upload_manifest');
    await ctx.uploadJson(BEATS_MANIFEST_PATH, manifest);
    const beats = manifest.tracks.reduce((n, t) => n + t.beats.length, 0);
    log.info('studio.beats done', { tracks: manifest.tracks.length, beats, bpm: manifest.tracks.map((t) => t.bpm) });
    return { manifest: BEATS_MANIFEST_PATH, summary: { tracks: manifest.tracks.length, beats, bpm: manifest.tracks[0]?.bpm ?? null } };
  };
}
