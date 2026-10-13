/**
 * yt-dlp như Studio chạy nó (ag-studio `packages/studio-engine/src/yt-dlp.ts`): cùng cờ, cùng cách đọc lỗi thành mã
 * (`classifyYtDlp`), để video mẫu tải qua máy farm hỏng thì Studio nhận đúng mã như khi tự tải. ADR-0001 mục 175 của
 * Studio: không cookie, không đăng nhập, không lách chặn; URL luôn dựng lại từ id 11 ký tự đã kiểm.
 */
import type { ReferenceFetchErrorCode } from '@ag-farm/protocol';

export const VIDEO_ID = /^[\w-]{11}$/;

/** URL video YouTube dựng từ id đã kiểm (như `youtubeVideoUrl` của Studio). */
export function youtubeVideoUrl(videoId: string): string {
  if (!VIDEO_ID.test(videoId)) throw new Error(`"${videoId}" is not a YouTube video id`);
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Mọi lần gọi (= `YTDLP_COMMON_ARGS` của Studio). YouTube cần một JavaScript runtime mới đưa danh sách định dạng
 * (yt-dlp 2025.11 trở đi): Node đang chạy worker luôn có sẵn, nên chỉ yt-dlp tới nó.
 */
export function ytdlpCommonArgs(nodePath: string = process.execPath): string[] {
  return ['--ignore-config', '--no-cookies', '--no-warnings', '--no-progress', '--js-runtimes', `node:${nodePath}`];
}

/** `300M` khi tròn MiB (đúng chữ Studio gửi), không thì số byte. yt-dlp đọc `M` là 1024². */
export function maxFilesizeArg(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes % mib === 0 ? `${bytes / mib}M` : String(bytes);
}

export interface DownloadArgsOptions {
  videoId: string;
  /** Thư mục nhận file `<id>.<ext>` (và `<id>.info.json`). */
  dir: string;
  maxHeight: number;
  maxSeconds: number;
  maxBytes: number;
  /** ffmpeg yt-dlp dùng để ghép hình và tiếng; không có thì yt-dlp tự tìm trên PATH. */
  ffmpeg?: string;
  nodePath?: string;
  /** Cách nối đường dẫn (mặc định `node:path` join). */
  join: (...parts: string[]) => string;
}

/**
 * Cờ tải một video mẫu: đúng `download()` của Studio (với trần mặc định thì từng chữ như nhau), cộng
 * `--write-info-json` để biết tiêu đề và kênh mà không gọi YouTube lần nữa (file JSON cạnh video, không đổi gì trên
 * stdout: yt-dlp vẫn nói các lần bỏ qua ở đó).
 */
export function downloadArgs(o: DownloadArgsOptions): string[] {
  const h = o.maxHeight;
  return [
    ...ytdlpCommonArgs(o.nodePath),
    '--no-playlist', '--no-part', '--restrict-filenames',
    '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*[height<=${h}]`, '--merge-output-format', 'mp4',
    '--max-filesize', maxFilesizeArg(o.maxBytes), '--match-filter', `duration<=${o.maxSeconds} & !is_live`,
    ...(o.ffmpeg ? ['--ffmpeg-location', o.ffmpeg] : []),
    '--write-info-json',
    '-o', o.join(o.dir, `${o.videoId}.%(ext)s`), '--', youtubeVideoUrl(o.videoId),
  ];
}

/** Lý do ngắn (tiếng Anh) khi yt-dlp không nói gì đọc được; Studio tự hiện lời của nó theo mã. */
export const YT_FAILURE_REASON: Record<Exclude<ReferenceFetchErrorCode, 'other'>, string> = {
  youtube_blocked: 'YouTube is blocking downloads from this machine (sign in to confirm you are not a bot)',
  private: 'private video',
  unavailable: 'no longer on YouTube (removed, taken down or never existed)',
  age_restricted: 'age-restricted video (needs a signed-in account)',
  members_only: "only for the channel's members",
  live: 'live stream or premiere not started',
  too_long: 'longer than the limit (or live)',
  too_big: 'bigger than the size limit at the allowed height',
  no_480p: 'no format at or below the allowed height',
  network: 'network error reaching YouTube',
  timeout: 'yt-dlp timed out',
};

export interface YtFailure {
  code: ReferenceFetchErrorCode;
  /** Lý do ngắn. */
  reason: string;
  /** Đầu dòng ERROR của yt-dlp (bỏ tiền tố). */
  detail: string;
}

const DETAIL_MAX = 200;

/** Đầu một dòng ERROR không kèm tiền tố ("ERROR: [youtube] <id>: "), cắt cho dễ đọc. */
function errorStart(line: string): string {
  const s = line.replace(/^ERROR:\s*/, '').replace(/^\[[\w:-]+\]\s*/, '').replace(/^[\w-]{11}:\s*/, '').replace(/\s+/g, ' ').trim();
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s;
}

/** Một dòng yt-dlp nói gì (cụ thể nhất trước: kiểm tuổi cũng đòi cookie). */
function codeOf(line: string): ReferenceFetchErrorCode | null {
  const l = line.toLowerCase().replace(/’/g, "'");
  if (/confirm your age|age[- ]restricted|inappropriate for some users/.test(l)) return 'age_restricted';
  if (/members[- ]only|join this channel|available to this channel's members/.test(l)) return 'members_only';
  if (/private video|video is private/.test(l)) return 'private';
  if (/does not pass filter/.test(l)) return 'too_long';
  if (/live event will begin|premieres in|this live event|is live now|currently live/.test(l)) return 'live';
  if (/not a bot|sign in to confirm|--cookies|http error 429|too many requests|rate[- ]limit/.test(l)) return 'youtube_blocked';
  if (/larger than max-filesize/.test(l)) return 'too_big';
  if (/requested format is not available|no video formats found/.test(l)) return 'no_480p';
  if (/video unavailable|has been removed|no longer available|been terminated|does not exist|is not available|http error 404/.test(l)) return 'unavailable';
  if (/unable to download|getaddrinfo|name resolution|connection (refused|reset|aborted)|network is unreachable|timed out|urlopen error|econnreset/.test(l)) return 'network';
  return null;
}

/**
 * Lời yt-dlp (stderr, và stdout với các lần bỏ qua nó in ở đó) → mã và lý do ngắn. Bot check ở bất kỳ dòng nào thắng
 * (máy bị chặn chứ không phải video); không thì dòng ERROR đầu tiên nói lý do, giữ phần đầu của nó.
 */
export function classifyYtDlp(output: string): YtFailure {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const blocked = lines.find((l) => codeOf(l) === 'youtube_blocked');
  const line = blocked ?? lines.find((l) => l.startsWith('ERROR')) ?? lines.find((l) => codeOf(l) !== null) ?? lines.at(-1) ?? '';
  const code = codeOf(line) ?? 'other';
  const detail = errorStart(line);
  return {
    code,
    reason: code === 'other' ? (detail ? `yt-dlp: ${detail}` : 'yt-dlp failed without saying why') : YT_FAILURE_REASON[code],
    detail,
  };
}
