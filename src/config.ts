/**
 * Cấu hình tuỳ riêng của ag-render-worker (nằm trong trường `extra` của WorkerConfig).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CapabilitiesOptions } from '@ag-farm/worker-sdk';
import { RENDER_FEATURE_LEVEL } from '@ag-studio/render';
import { resolveFfmpeg } from './ffmpeg-utils.js';

/**
 * Tên gói của worker này trong `/dist/latest.json` của hub (scripts/release.mjs phát hành dưới tên này). Worker tự cập
 * nhật theo nó (worker-sdk `selfUpdate`), installer cài vai trò `render` từ gói cùng tên.
 */
export const RELEASE_PACKAGE = 'ag-render-worker';

export interface RenderWorkerExtra {
  /** Đường dẫn Python executable. Mặc định: 'python'. */
  python_bin?: string;
  /**
   * yt-dlp (installer: `<InstallDir>\venv\Scripts\yt-dlp.exe`). Không có thì `yt-dlp` cạnh `python_bin` (cùng venv), không
   * có nữa thì `yt-dlp` trên PATH. Máy chạy được nó thì khai `engines.ytdlp`.
   */
  ytdlp_bin?: string;
  /** Thư mục model Hugging Face cho engine Python (`HF_HOME`; installer: `<InstallDir>\models`). Mặc định: của tài khoản chạy. */
  hf_home?: string;
  /** Timeout (giây) cho tiến trình Python TTS. Mặc định: 600. */
  python_timeout_s?: number;
  /** Giải phóng model Ollama trước khi chạy TTS (hữu ích khi cùng máy với scan worker). */
  unload_ollama_before_tts?: boolean;
  /** URL Ollama. Mặc định: 'http://localhost:11434'. */
  ollama_url?: string;
  /** Timeout (giây) cho mỗi lệnh ffmpeg. Mặc định: 3600. */
  ffmpeg_timeout_s?: number;
  /** Thư mục chứa arial.ttf. Mặc định: thư mục font của hệ điều hành (xem fonts.ts). */
  fonts_dir?: string;
  /** Thư mục font OFL đóng kèm (có `fonts.json`). Mặc định: `fonts/` của gói (xem fonts.ts). */
  bundled_fonts_dir?: string;
  /**
   * WhisperX model that hears a voice sample's words once per studio.tts job when Studio sent none (OmniVoice clones
   * better with them). Default 'large-v3', the model studio.transcribe uses; '' = read without them.
   */
  tts_ref_asr_model?: string;
  /** Thiết bị cho TTS: 'auto' (cuda nếu máy có GPU NVIDIA, không thì cpu), 'cuda', 'cpu'. Mặc định: 'auto'. */
  tts_device?: string;
  /** Encoder cho render: 'auto' (NVENC nếu có, không thì CPU), 'nvenc' hoặc 'cpu'. Mặc định: 'auto'. */
  encoder?: 'auto' | 'nvenc' | 'cpu';
  /** Thư mục cache mezzanine dùng chung giữa các job. Mặc định (main.ts): `<cache.dir>-mezz`. */
  mezz_cache_dir?: string;
  /** Trần dung lượng cache mezzanine (GB). Mặc định: 20. */
  mezz_cache_gb?: number;
  /** Thiết bị cho nhận dạng lời nói: 'auto' (như tts_device), 'cuda', 'cuda:1', 'cpu'. Mặc định: 'auto'. */
  transcribe_device?: string;
  /** compute_type của faster-whisper. Mặc định: float16 trên GPU, int8 trên CPU. */
  transcribe_compute_type?: string;
  /** batch_size của WhisperX. Mặc định: 8 (hạ xuống 4 nếu thiếu VRAM). */
  transcribe_batch_size?: number;
}

export function getExtra(extra: Record<string, unknown> | undefined): RenderWorkerExtra {
  if (!extra) return {};
  return {
    python_bin: typeof extra['python_bin'] === 'string' ? extra['python_bin'] : undefined,
    ytdlp_bin: typeof extra['ytdlp_bin'] === 'string' && extra['ytdlp_bin'] ? extra['ytdlp_bin'] : undefined,
    hf_home: typeof extra['hf_home'] === 'string' && extra['hf_home'] ? extra['hf_home'] : undefined,
    python_timeout_s:
      typeof extra['python_timeout_s'] === 'number' ? extra['python_timeout_s'] : undefined,
    unload_ollama_before_tts:
      typeof extra['unload_ollama_before_tts'] === 'boolean'
        ? extra['unload_ollama_before_tts']
        : undefined,
    ollama_url: typeof extra['ollama_url'] === 'string' ? extra['ollama_url'] : undefined,
    ffmpeg_timeout_s:
      typeof extra['ffmpeg_timeout_s'] === 'number' ? extra['ffmpeg_timeout_s'] : undefined,
    fonts_dir: typeof extra['fonts_dir'] === 'string' ? extra['fonts_dir'] : undefined,
    bundled_fonts_dir: typeof extra['bundled_fonts_dir'] === 'string' ? extra['bundled_fonts_dir'] : undefined,
    tts_device: typeof extra['tts_device'] === 'string' ? extra['tts_device'] : undefined,
    encoder:
      extra['encoder'] === 'auto' || extra['encoder'] === 'nvenc' || extra['encoder'] === 'cpu'
        ? extra['encoder']
        : undefined,
    mezz_cache_dir: typeof extra['mezz_cache_dir'] === 'string' ? extra['mezz_cache_dir'] : undefined,
    mezz_cache_gb:
      typeof extra['mezz_cache_gb'] === 'number' && extra['mezz_cache_gb'] > 0
        ? extra['mezz_cache_gb']
        : undefined,
    transcribe_device: typeof extra['transcribe_device'] === 'string' ? extra['transcribe_device'] : undefined,
    transcribe_compute_type:
      typeof extra['transcribe_compute_type'] === 'string' ? extra['transcribe_compute_type'] : undefined,
    transcribe_batch_size:
      typeof extra['transcribe_batch_size'] === 'number' && Number.isInteger(extra['transcribe_batch_size']) &&
      extra['transcribe_batch_size'] > 0
        ? extra['transcribe_batch_size']
        : undefined,
  };
}

/** yt-dlp worker chạy: `extra.ytdlp_bin`, không có thì bản trong venv của `python_bin`, không có nữa thì PATH. */
export function resolveYtdlp(extra: RenderWorkerExtra, exists: (p: string) => boolean = existsSync): string {
  if (extra.ytdlp_bin) return extra.ytdlp_bin;
  if (extra.python_bin && /[\\/]/.test(extra.python_bin)) {
    const besidePython = join(dirname(extra.python_bin), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (exists(besidePython)) return besidePython;
  }
  return 'yt-dlp';
}

/**
 * Phép dò năng lực của máy, bằng đúng các binary handler sẽ chạy: Python+torch của engine TTS/transcribe (không dò thì
 * máy khai `python: null` và hub không bao giờ giao `studio.tts`/`studio.transcribe`), ffmpeg kèm trong gói (máy worker
 * thường không có ffmpeg trên PATH: dò PATH thì máy khai `ffmpeg: null`, NVENC false) và yt-dlp.
 */
export function capabilitiesOptionsFor(
  extra: RenderWorkerExtra,
  exists: (p: string) => boolean = existsSync,
  /** Kết quả tự kiểm lúc khởi động (self-check.ts): thiếu engine Python thì không dò Python, thiếu font thì hạ mức render. */
  check?: { python: boolean; studioRender: number },
): CapabilitiesOptions {
  return {
    detectPythonTorch: check?.python ?? true,
    pythonBin: extra.python_bin,
    ffmpegPath: resolveFfmpeg(),
    ytdlpBin: resolveYtdlp(extra, exists),
    // the composition features this build renders: the farm sends a newer composition only to a machine at its level
    studioRender: check?.studioRender ?? RENDER_FEATURE_LEVEL,
  };
}
