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
  };
}
