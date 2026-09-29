/**
 * Cấu hình tuỳ riêng của ag-render-worker (nằm trong trường `extra` của WorkerConfig).
 */

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
  /** Encoder cho render: 'auto' (NVENC nếu có, không thì CPU), 'nvenc' hoặc 'cpu'. Mặc định: 'auto'. */
  encoder?: 'auto' | 'nvenc' | 'cpu';
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
    encoder:
      extra['encoder'] === 'auto' || extra['encoder'] === 'nvenc' || extra['encoder'] === 'cpu'
        ? extra['encoder']
        : undefined,
  };
}
