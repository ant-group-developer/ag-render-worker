/**
 * Handler studio.reference_fetch: tải một video YouTube mẫu cho Studio (YouTube chặn IP máy chủ Studio, máy farm ở văn
 * phòng thì không). yt-dlp của máy (venv cạnh `python_bin`, xem `resolveYtdlp`) chạy với đúng cờ của Studio: không
 * cookie, không đăng nhập, ≤ 480p / ≤ 30 phút / ≤ 300 MB, URL dựng lại từ id đã kiểm. Đo bằng ffprobe kèm gói, đẩy file
 * lên `output`, rồi xoá mọi file trên máy. Hỏng vì YouTube thì lỗi mang mã như `classifyYtDlp` của Studio.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { StudioReferenceFetchPayloadSchema, REFERENCE_FETCH_RETRYABLE_CODES } from '@ag-farm/protocol';
import type { JobResult, StudioReferenceFetchResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { childEnvWithoutSecrets, JobFailure, NonRetryableError, runProcess } from '@ag-farm/worker-sdk';
import { resolveYtdlp, type RenderWorkerExtra } from './config.js';
import { probeMedia, resolveFfmpeg, resolveFfprobe } from './ffmpeg-utils.js';
import { classifyYtDlp, downloadArgs, VIDEO_ID, YT_FAILURE_REASON, type YtFailure } from './yt-dlp.js';

/** Như Studio (`DOWNLOAD_TIMEOUT_MS`). */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Giữ chừng này dòng mỗi luồng (lời yt-dlp ngắn; dòng ERROR đầu là thứ cần). */
const MAX_LINES = 2000;
/** ffprobe đo độ dài lệch chút so với YouTube. */
const DURATION_SLACK_S = 2;

export interface ReferenceFetchHandlerContext {
  extra?: RenderWorkerExtra;
  /** Chương trình yt-dlp và các tham số đầu (test: node + script giả). Mặc định: `resolveYtdlp(extra)`. */
  ytdlpArgv?: readonly string[];
  ffmpeg?: string;
  ffprobe?: string;
  timeoutMs?: number;
}

const CONTENT_TYPES: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };

function failure(f: YtFailure): JobFailure {
  return new JobFailure(f.code, f.detail || f.reason, REFERENCE_FETCH_RETRYABLE_CODES.includes(f.code));
}

/** ffmpeg yt-dlp nên dùng: chỉ khi là đường dẫn thật (bản kèm gói); `ffmpeg` trên PATH thì yt-dlp tự tìm. */
function ffmpegLocation(ffmpeg: string): string | undefined {
  return /[\\/]/.test(ffmpeg) ? ffmpeg : undefined;
}

/** Tiêu đề và kênh trong `<id>.info.json` (rỗng khi không đọc được: video vẫn dùng được). */
function readInfo(path: string): { title: string; channel: string } {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 500) : '');
    return { title: str(j['title']), channel: str(j['channel']) || str(j['uploader']) };
  } catch {
    return { title: '', channel: '' };
  }
}

export function makeStudioReferenceFetchHandler(
  overrides: ReferenceFetchHandlerContext = {},
): (ctx: JobContext) => Promise<JobResult> {
  return async (ctx: JobContext): Promise<JobResult> => {
    const parsed = StudioReferenceFetchPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new NonRetryableError('invalid_payload', `Invalid studio.reference_fetch payload: ${parsed.error.message}`);
    }
    const payload = parsed.data;
    // schema đã kiểm; kiểm lại ngay trước khi id thành tham số của một chương trình khác
    if (!VIDEO_ID.test(payload.video_id)) throw new NonRetryableError('invalid_payload', 'video_id is not a YouTube id');
    const extra: RenderWorkerExtra = overrides.extra ?? {};
    const log = ctx.log.child({ handler: 'studio.reference_fetch', production_id: payload.production_id, video_id: payload.video_id });

    const [bin, ...head] = overrides.ytdlpArgv ?? [resolveYtdlp(extra)];
    if (!bin) throw new NonRetryableError('ytdlp_missing', 'No yt-dlp on this machine');
    const dir = join(ctx.workDir, 'reference');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    try {
      ctx.progress(5, 'download');
      const ffmpeg = ffmpegLocation(overrides.ffmpeg ?? resolveFfmpeg());
      const args = downloadArgs({
        videoId: payload.video_id, dir, join,
        maxHeight: payload.max_height, maxSeconds: payload.max_seconds, maxBytes: payload.max_bytes,
        ...(ffmpeg ? { ffmpeg } : {}),
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const keep = (into: string[]) => (line: string) => { if (into.length < MAX_LINES) into.push(line); };
      const timeoutMs = overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      log.info('Starting studio.reference_fetch', { max_height: payload.max_height, max_seconds: payload.max_seconds });
      const run = await runProcess(bin, [...head, ...args], {
        timeoutMs, signal: ctx.signal, env: childEnvWithoutSecrets(), cwd: dir,
        onStdoutLine: keep(stdout), onStderrLine: keep(stderr),
      });
      if (ctx.signal.aborted) throw new Error('studio.reference_fetch aborted');
      if (run.exitCode === null) {
        if (run.signal) throw failure({ code: 'timeout', reason: YT_FAILURE_REASON.timeout, detail: `yt-dlp ran over ${Math.round(timeoutMs / 1000)} s` });
        throw new Error(`yt-dlp could not start (${bin})`);
      }
      const said = `${stdout.join('\n')}\n${stderr.join('\n')}`;
      if (run.exitCode !== 0) {
        throw failure(classifyYtDlp(stderr.some((l) => l.trim()) ? stderr.join('\n') : `yt-dlp exit ${run.exitCode}`));
      }
      const file = readdirSync(dir).find(
        (f) => f.startsWith(`${payload.video_id}.`) && !f.endsWith('.part') && !f.endsWith('.json') && !f.endsWith('.ytdl'),
      );
      if (!file) {
        // yt-dlp không coi một lần bỏ qua là lỗi: bộ lọc độ dài và trần dung lượng nói trên stdout, exit 0
        const f = classifyYtDlp(said);
        throw failure(f.code === 'other' ? { code: 'no_480p', reason: YT_FAILURE_REASON.no_480p, detail: f.detail } : f);
      }
      const path = join(dir, file);

      ctx.progress(70, 'probe');
      const size = statSync(path).size;
      if (size > payload.max_bytes) {
        throw failure({ code: 'too_big', reason: YT_FAILURE_REASON.too_big, detail: `${size} bytes > ${payload.max_bytes}` });
      }
      const probe = await probeMedia(path, overrides.ffprobe ?? resolveFfprobe());
      if (probe.duration_seconds > payload.max_seconds + DURATION_SLACK_S) {
        throw failure({ code: 'too_long', reason: YT_FAILURE_REASON.too_long, detail: `${Math.round(probe.duration_seconds)} s > ${payload.max_seconds} s` });
      }
      const info = readInfo(join(dir, `${payload.video_id}.info.json`));
      const ext = extname(file).slice(1).toLowerCase();

      ctx.progress(80, 'upload');
      await ctx.upload(path, payload.output, CONTENT_TYPES[ext] ?? 'application/octet-stream', { signal: ctx.signal });

      const summary: StudioReferenceFetchResult = {
        output: payload.output,
        ext,
        duration_s: Math.round(probe.duration_seconds * 1000) / 1000,
        size_bytes: size,
        width: probe.width,
        height: probe.height,
        title: info.title,
        channel: info.channel,
      };
      log.info('studio.reference_fetch done', { size_bytes: size, duration_s: summary.duration_s, height: probe.height });
      return { manifest: null, summary };
    } finally {
      // video mẫu không bao giờ nằm lại trên máy (SDK cũng xoá workDir, đây là chắc ăn)
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (err) {
        log.warn('Could not delete the reference video yet (the SDK deletes the job folder next)', { err: String(err) });
      }
    }
  };
}
