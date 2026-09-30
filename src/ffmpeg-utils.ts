/**
 * Tiện ích ffmpeg/ffprobe: resolve đường dẫn binary, probe media, cắt đoạn nguồn.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { childEnvWithoutSecrets } from '@ag-farm/worker-sdk';

const execFileAsync = promisify(execFile);
const _require = createRequire(import.meta.url);

// ---- Resolve binary paths ----

function resolveBinaryPath(envKey: string, fallbackName: string, staticPkg: string): string {
  const fromEnv = process.env[envKey];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const mod = _require(staticPkg) as unknown;
    // ffmpeg-static trả string, ffprobe-static trả { path: string }
    const p: unknown =
      mod && typeof mod === 'object' && 'path' in (mod as object)
        ? (mod as { path: unknown }).path
        : mod;
    if (typeof p === 'string' && p && existsSync(p)) return p;
  } catch {
    // package không được cài hoặc không có binary
  }
  return fallbackName; // dùng PATH
}

export function resolveFfmpeg(): string {
  return resolveBinaryPath('FFMPEG_PATH', 'ffmpeg', 'ffmpeg-static');
}

export function resolveFfprobe(): string {
  return resolveBinaryPath('FFPROBE_PATH', 'ffprobe', 'ffprobe-static');
}

// ---- Probe media ----

export interface MediaProbeResult {
  duration_seconds: number;
  width: number;
  height: number;
  fps: number | null;
  has_audio: boolean;
}

/**
 * Probe file bằng ffprobe, trả thông tin cơ bản.
 * Dùng cho cả file cục bộ và URL ký.
 */
export async function probeMedia(
  pathOrUrl: string,
  ffprobe?: string,
): Promise<MediaProbeResult> {
  const probe = ffprobe ?? resolveFfprobe();
  const localPath = normalizeSourcePath(pathOrUrl);
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    localPath,
  ];

  const { stdout } = await execFileAsync(probe, args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const data = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string };
  };

  const streams = data.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const duration =
    parseFloat(videoStream?.duration ?? data.format?.duration ?? '0') || 0;
  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;

  let fps: number | null = null;
  const fpsStr = videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate;
  if (fpsStr && fpsStr !== '0/0') {
    const parts = fpsStr.split('/');
    const num = parseFloat(parts[0] ?? '0');
    const den = parseFloat(parts[1] ?? '1');
    if (den > 0) fps = Math.round((num / den) * 100) / 100;
  }

  return {
    duration_seconds: duration,
    width,
    height,
    fps,
    has_audio: audioStream !== undefined,
  };
}

// ---- Tiện ích nội bộ ----

/**
 * Convert a file:// URL to a local file path.
 * ffmpeg/ffprobe do not support the file:// scheme on Windows.
 */
function normalizeSourcePath(sourceUrl: string): string {
  if (sourceUrl.startsWith('file://')) {
    try {
      const { fileURLToPath } = require('node:url') as typeof import('node:url');
      return fileURLToPath(sourceUrl);
    } catch {
      // fallback: strip file:// prefix manually
      const stripped = sourceUrl.slice('file://'.length);
      // On Windows: file:///C:/path → /C:/path → C:/path
      return stripped.replace(/^\/([A-Za-z]:)/, '$1');
    }
  }
  return sourceUrl;
}

// ---- Chạy ffmpeg ----

interface RunFfmpegOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Working directory for the ffmpeg process (useful for relative filter paths). */
  cwd?: string;
}

export async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  opts: RunFfmpegOptions = {},
): Promise<void> {
  const { timeoutMs = 3_600_000, signal, cwd } = opts;
  const env = childEnvWithoutSecrets();

  return new Promise<void>((resolve, reject) => {
    let stderrTail = '';
    let settled = false;

    const child = spawn(ffmpeg, args, {
      windowsHide: true,
      env,
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const onAbort = () => {
      killTree(child.pid);
      settle(new Error('ffmpeg aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    child.on('error', (e) => settle(new Error(`ffmpeg spawn error: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (timedOut) {
        settle(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        settle(new Error(`ffmpeg exited ${String(code)}: ${stderrTail.slice(-500)}`));
      } else {
        settle();
      }
    });
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => {});
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // ignore
  }
}
