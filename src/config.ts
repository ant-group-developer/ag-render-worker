/**
 * Cấu hình tuỳ riêng của ag-render-worker (nằm trong trường `extra` của WorkerConfig).
 */
import type { CapabilitiesOptions } from '@ag-farm/worker-sdk';

export interface RenderWorkerExtra {
  /** Đường dẫn Python executable. Mặc định: 'python'. */
  python_bin?: string;
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

/**
 * Phép dò năng lực của máy: luôn dò Python+torch, bằng đúng interpreter mà engine TTS/transcribe sẽ chạy. Không dò thì
 * máy khai `python: null` và hub không bao giờ giao `studio.tts`/`studio.transcribe` (cả hai cần `python: true`).
 */
export function capabilitiesOptionsFor(extra: RenderWorkerExtra): CapabilitiesOptions {
  return { detectPythonTorch: true, pythonBin: extra.python_bin };
}
