/**
 * Handler studio.tts: đọc từng câu lời dẫn thành WAV bằng OmniVoice.
 * Output: tts/<line_id>.wav và tts.json (TtsManifestSchema).
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  StudioTtsPayloadSchema,
  TtsManifestSchema,
  TTS_MANIFEST_SCHEMA,
  TTS_MANIFEST_PATH,
} from '@ag-farm/protocol';
import type { JobResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import { unloadOllamaModels } from './ollama.js';
import type { PythonRunner } from './python-runner.js';
import { createPythonRunner } from './python-runner.js';
import type { RenderWorkerExtra } from './config.js';

// ---- Engines dir ----

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Đường dẫn tới thư mục engines/python của repo này. */
function defaultEnginesDir(): string {
  // src/ → ../ → engines/python
  return join(__dirname, '..', 'engines', 'python');
}

/**
 * `cuda` when the machine has an NVIDIA GPU (nvidia-smi answers), else `cpu`; `extra.tts_device` overrides.
 * Checked once per process.
 */
let detectedDevice: 'cuda' | 'cpu' | null = null;
export function resolveTtsDevice(configured: string | undefined): string {
  if (configured && configured !== 'auto') return configured;
  if (detectedDevice === null) {
    const r = spawnSync('nvidia-smi', ['-L'], { timeout: 5_000, windowsHide: true });
    detectedDevice = r.status === 0 && String(r.stdout).includes('GPU') ? 'cuda' : 'cpu';
  }
  return detectedDevice;
}

// ---- Handler ----

/** Context tuỳ chỉnh để inject runner (dùng trong tests). */
export interface TtsHandlerContext {
  runner?: PythonRunner;
  extra?: RenderWorkerExtra;
  enginesDir?: string;
}

/**
 * Tạo handler có thể inject runner.
 * Dùng makeStudioTtsHandler({}) khi triển khai thật;
 * dùng makeStudioTtsHandler({ runner: fakeRunner }) trong tests.
 */
export function makeStudioTtsHandler(
  overrides: TtsHandlerContext = {},
): (ctx: JobContext) => Promise<JobResult> {
  return async (ctx: JobContext): Promise<JobResult> => {
    // 1. Validate payload
    const payloadResult = StudioTtsPayloadSchema.safeParse(ctx.payload);
    if (!payloadResult.success) {
      throw new NonRetryableError(
        'invalid_payload',
        `Invalid studio.tts payload: ${payloadResult.error.message}`,
      );
    }
    const payload = payloadResult.data;

    // Lấy extra config từ job context (truyền qua job.payload không; dùng worker config extra)
    const extra: RenderWorkerExtra = overrides.extra ?? {};
    const pythonBin = extra.python_bin ?? 'python';
    const pythonTimeoutMs = (extra.python_timeout_s ?? 600) * 1000;
    const ollamaUrl = extra.ollama_url ?? 'http://localhost:11434';

    const log = ctx.log.child({ handler: 'studio.tts', production_id: payload.production_id });
    log.info('Starting studio.tts', { lines: payload.lines.length, language: payload.language });

    ctx.progress(2, 'init');

    // 2. Download voice reference nếu có
    let refAudioLocalPath = '';
    if (payload.voice.reference !== null) {
      const refLocal = join(ctx.workDir, 'ref_audio.wav');
      log.info('Downloading voice reference', { input: payload.voice.reference });
      await ctx.download(payload.voice.reference, refLocal);
      refAudioLocalPath = refLocal;
    }

    ctx.progress(10, 'unload_ollama');

    // 3. Unload Ollama nếu được yêu cầu
    if (extra.unload_ollama_before_tts === true) {
      log.info('Unloading Ollama models before TTS', { ollamaUrl });
      await unloadOllamaModels(ollamaUrl);
    }

    ctx.progress(12, 'build_job');

    // 4. Chuẩn bị thư mục output
    const ttsDir = join(ctx.workDir, 'tts');
    mkdirSync(ttsDir, { recursive: true });

    // 5. Xây dựng Python engine job
    const engineLines = payload.lines.map((line) => ({
      line_id: line.line_id,
      chunks: [line.text],  // mỗi line là một chunk (không chia nhỏ ở đây)
      out_path: join(ttsDir, `${line.line_id}.wav`),
      pause_seconds: line.pause_seconds,
    }));

    const device = resolveTtsDevice(extra.tts_device);
    const engineJob = {
      device,
      model: 'k2-fsa/OmniVoice',
      // half precision on the GPU (less VRAM, faster); the CPU runs float32
      dtype: device === 'cpu' ? 'float32' : 'float16',
      num_step: 10,
      speed: payload.voice.speed,
      language: payload.language,
      ref_audio: refAudioLocalPath || '',
      ref_text: payload.voice.reference_text ?? '',
      // no sample: the voice is designed from this description (OmniVoice `instruct`)
      instruct: payload.voice.instruct ?? null,
      align: payload.align_words,
      lines: engineLines,
    };

    ctx.progress(15, 'tts');

    // 6. Chạy Python TTS engine
    const enginesDir = overrides.enginesDir ?? defaultEnginesDir();
    const runner: PythonRunner =
      overrides.runner ??
      createPythonRunner({
        pythonBin,
        enginesDir,
        timeoutMs: pythonTimeoutMs,
      });

    log.info('Running TTS engine', { lines: payload.lines.length });
    const runResult = await runner(engineJob, ttsDir, ctx.signal);

    if (runResult.kind !== 'ok') {
      const retryable = runResult.kind === 'transient';
      if (!retryable) {
        throw new NonRetryableError('tts_contract_error', `TTS engine contract error: ${runResult.reason}`);
      }
      throw new Error(`TTS engine failed (transient): ${runResult.reason}`);
    }

    const { lines: resultLines } = runResult.result;

    ctx.progress(70, 'upload_wavs');

    // 7. Upload tts/<line_id>.wav
    const manifestLines: Array<{
      line_id: string;
      output: string;
      duration_s: number;
      words: Array<{ word: string; start: number; end: number }>;
    }> = [];

    for (const rl of resultLines) {
      const outputPath = `tts/${rl.line_id}.wav`;
      await ctx.upload(rl.wav_path, outputPath, 'audio/wav');

      manifestLines.push({
        line_id: rl.line_id,
        output: outputPath,
        duration_s: rl.duration_seconds,
        words: (rl.words ?? []).map((w) => ({
          word: w.word,
          start: w.start,
          end: w.end,
        })),
      });

      ctx.progress(
        70 + Math.round(25 * (manifestLines.length / resultLines.length)),
        'upload_wavs',
      );
    }

    ctx.progress(95, 'upload_manifest');

    // 8. Upload tts.json
    const manifest = TtsManifestSchema.parse({
      schema: TTS_MANIFEST_SCHEMA,
      production_id: payload.production_id,
      language: payload.language,
      lines: manifestLines,
      engine: { name: 'omnivoice', version: null },
    });

    await ctx.uploadJson(TTS_MANIFEST_PATH, manifest);

    log.info('studio.tts done', { lines: manifestLines.length });

    return {
      manifest: TTS_MANIFEST_PATH,
      summary: { lines: manifestLines.length, language: payload.language },
    };
  };
}

/** Handler tiêu chuẩn dùng khi triển khai thật (không inject). */
export const handleStudioTts = makeStudioTtsHandler();
