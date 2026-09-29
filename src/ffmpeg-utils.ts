/**
 * Tiện ích ffmpeg/ffprobe: resolve đường dẫn binary, probe media, cắt đoạn nguồn.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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

// ---- Cắt đoạn nguồn thành mezzanine cục bộ ----

export interface CutOptions {
  /** Thời điểm bắt đầu cắt trong nguồn (giây). */
  startSeconds: number;
  /** Thời lượng cắt (giây). */
  durationSeconds: number;
  /** Chất lượng cao (final) hay nhanh (preview). */
  quality: 'preview' | 'final';
  /** Timeout (ms). Mặc định: 3600_000. */
  timeoutMs?: number;
  /** AbortSignal để huỷ. */
  signal?: AbortSignal;
}

/**
 * Cắt đoạn từ URL/path nguồn ra file mp4 cục bộ.
 * Preview: scale max 1280px cạnh dài, CRF 26, preset fast.
 * Final: giữ độ phân giải gốc, CRF 18, preset slow.
 */
/**
 * Convert a file:// URL to a local file path.
 * ffmpeg does not support the file:// scheme on Windows.
 */
function normalizeSourcePath(sourceUrl: string): string {
  if (sourceUrl.startsWith('file://')) {
    try {
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

export async function cutSegmentToMezz(
  sourceUrl: string,
  outputPath: string,
  opts: CutOptions,
): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  const { startSeconds, durationSeconds, quality, timeoutMs = 3_600_000, signal } = opts;
  const sourcePath = normalizeSourcePath(sourceUrl);

  const vfParts: string[] = [];
  if (quality === 'preview') {
    // Scale: giữ tỷ lệ, cạnh dài ≤ 1280, chia hết cho 2
    vfParts.push("scale='if(gt(iw,ih),min(iw,1280),-2)':'if(gt(iw,ih),-2,min(ih,1280))'");
  }

  const crf = quality === 'preview' ? '26' : '18';
  const preset = quality === 'preview' ? 'fast' : 'slow';

  const args: string[] = [
    '-ss', String(startSeconds),
    '-i', sourcePath,
    '-t', String(durationSeconds),
    '-c:v', 'libx264',
    '-crf', crf,
    '-preset', preset,
    ...(vfParts.length > 0 ? ['-vf', vfParts.join(',')] : []),
    '-c:a', 'aac',
    '-ac', '2',
    '-ar', '48000',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

  await runFfmpeg(ffmpeg, args, { timeoutMs, signal });
}

// ---- Chạy ffmpeg ----

interface RunFfmpegOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  opts: RunFfmpegOptions = {},
): Promise<void> {
  const { timeoutMs = 3_600_000, signal } = opts;
  const env = childEnvWithoutSecrets();

  return new Promise<void>((resolve, reject) => {
    let stderrTail = '';
    let settled = false;

    const child = spawn(ffmpeg, args, {
      windowsHide: true,
      env,
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
