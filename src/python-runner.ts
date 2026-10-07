/**
 * Injectable Python engine runner dùng cho handler TTS, transcribe và cho tests.
 * Contract giống PythonMediaEngine của @harness/adapters/media-python:
 * ghi job JSON ra file tạm, spawn python <script>.py, đọc result JSON.
 */
import { spawn } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { resolveFfmpeg } from './ffmpeg-utils.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const STDERR_TAIL = 2000;

export interface TtsResultLine {
  line_id: string;
  wav_path: string;
  duration_seconds: number;
  chunks: { text: string; start: number; end: number }[];
  words: { word: string; start: number; end: number }[] | null;
  alignment: 'word' | 'chunk';
}

export interface TtsEngineResult {
  lines: TtsResultLine[];
}

export interface TtsEngineJob {
  device: string;
  model: string;
  dtype: string;
  num_step: number;
  speed: number;
  language: string;
  ref_audio: string;
  ref_text: string;
  /** OmniVoice voice design when there is no `ref_audio` (e.g. "female, young adult"). */
  instruct?: string | null;
  /** WhisperX model that hears a sample's words once when `ref_text` is empty; null: read without them. */
  ref_asr_model?: string | null;
  /** Its faster-whisper compute type (the transcribe stage's: `extra.transcribe_compute_type`, else by device). */
  ref_asr_compute_type?: string | null;
  align: boolean;
  lines: Array<{
    line_id: string;
    chunks: string[];
    out_path: string;
    pause_seconds: number | null;
  }>;
}

export interface PythonRunnerOptions {
  pythonBin: string;
  enginesDir: string;
  timeoutMs: number;
  dryRun?: boolean;
}

export type EngineRunResult<R> =
  | { kind: 'ok'; result: R }
  | { kind: 'contract' | 'transient'; reason: string };

type PythonRunResult = EngineRunResult<TtsEngineResult>;

/** Chạy một script engine bất kỳ; `result` là object JSON `ok: true` nguyên văn. */
export type EngineRunner = (
  job: object,
  outDir: string,
  signal?: AbortSignal,
) => Promise<EngineRunResult<Record<string, unknown>>>;

export type PythonRunner = (
  job: TtsEngineJob,
  outDir: string,
  /** Huỷ job (mất lease, bị cancel): tiến trình Python bị kill ngay. */
  signal?: AbortSignal,
) => Promise<PythonRunResult>;

/**
 * Env của tiến trình Python: thêm thư mục ffmpeg của worker (ffmpeg-static, cài qua npm) vào đầu PATH, vì
 * các thư viện audio của engine gọi `ffmpeg` theo PATH và máy worker thường không cài ffmpeg riêng.
 */
function pythonEnv(): NodeJS.ProcessEnv {
  const ffmpeg = resolveFfmpeg();
  // a bare command name ("ffmpeg") is already found on PATH
  if (!/[\\/]/.test(ffmpeg)) return process.env;
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...process.env, [key]: `${dirname(ffmpeg)}${delimiter}${process.env[key] ?? ''}` };
}

/**
 * Tạo runner thật: spawn python tts.py với job/result JSON files.
 */
export function createPythonRunner(opts: PythonRunnerOptions): PythonRunner {
  const run = createEngineRunner({ ...opts, script: 'tts.py' });
  return async (job: TtsEngineJob, outDir: string, signal?: AbortSignal): Promise<PythonRunResult> => {
    const r = await run(job, outDir, signal);
    if (r.kind !== 'ok') return r;
    const lines = r.result['lines'];
    if (!Array.isArray(lines)) {
      return { kind: 'transient', reason: 'python result.lines is not an array' };
    }
    return { kind: 'ok', result: { lines: lines as TtsResultLine[] } };
  };
}

/**
 * Runner chung: spawn `python <enginesDir>/<script> --job … --result …`, đọc file result. Exit code khác 0, timeout,
 * huỷ, file result thiếu/hỏng đều là `transient`; `{ ok: false, kind: "contract" }` là `contract`.
 */
export function createEngineRunner(opts: PythonRunnerOptions & { script: string }): EngineRunner {
  return async (job: object, outDir: string, signal?: AbortSignal): Promise<EngineRunResult<Record<string, unknown>>> => {
    if (signal?.aborted) return { kind: 'transient', reason: 'aborted before start' };
    const id = randomUUID();
    const jobPath = join(outDir, `engine-job-${id}.json`);
    const resultPath = join(outDir, `engine-result-${id}.json`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(jobPath, JSON.stringify(job), 'utf8');

    const scriptPath = join(opts.enginesDir, opts.script);
    const args = ['--job', jobPath, '--result', resultPath];
    if (opts.dryRun) args.push('--dry-run');

    let stderrTail = '';
    let aborted = false;
    const outcome = await new Promise<{ code: number | null; timedOut: boolean; spawnError: Error | null }>(
      (resolve) => {
        let settled = false;
        const child = spawn(opts.pythonBin, [scriptPath, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: pythonEnv(),
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, opts.timeoutMs);
        const onAbort = () => {
          aborted = true;
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const settle = (r: { code: number | null; timedOut: boolean; spawnError: Error | null }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        };
        child.stdout?.resume();
        child.stderr?.on('data', (d: Buffer) => {
          stderrTail = (stderrTail + String(d)).slice(-STDERR_TAIL);
        });
        child.on('error', (e) => settle({ code: null, timedOut, spawnError: e }));
        child.on('close', (code) => settle({ code, timedOut, spawnError: null }));
      },
    );

    const cleanup = () => {
      try { rmSync(jobPath, { force: true }); } catch { /* ignore */ }
      try { rmSync(resultPath, { force: true }); } catch { /* ignore */ }
    };

    if (outcome.spawnError) {
      cleanup();
      return { kind: 'transient', reason: `failed to start python: ${outcome.spawnError.message}` };
    }
    if (aborted) {
      cleanup();
      return { kind: 'transient', reason: 'aborted' };
    }
    if (outcome.timedOut) {
      cleanup();
      return { kind: 'transient', reason: `python engine timed out after ${opts.timeoutMs}ms` };
    }
    if (outcome.code !== 0) {
      cleanup();
      return {
        kind: 'transient',
        reason: `python engine exited ${String(outcome.code)}${stderrTail ? `: ${stderrTail}` : ''}`,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch (e) {
      cleanup();
      return { kind: 'transient', reason: `invalid result JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    cleanup();

    const obj = raw as Record<string, unknown>;
    if (obj['ok'] === false) {
      const kind = obj['kind'] === 'contract' ? 'contract' : 'transient';
      const reason = typeof obj['reason'] === 'string' ? obj['reason'] : 'no reason';
      return { kind, reason };
    }
    if (obj['ok'] !== true) {
      return { kind: 'transient', reason: "python result missing 'ok' flag" };
    }

    return { kind: 'ok', result: obj };
  };
}
