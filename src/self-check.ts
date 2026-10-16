/**
 * Tự kiểm khi worker khởi động (kế hoạch feedback-vps 2026-10-15, Phase 5): bản cài thiếu file thì máy vẫn chạy, nhưng
 * không nhận việc nó sẽ làm hỏng. Trên prod, 0.6.0–0.8.0 thiếu `transcribe.py` và mọi job `studio.transcribe` lỗi Errno 2
 * tới khi có người đọc log.
 *
 * - Thiếu file engine Python (`engines/python/tts.py`, `transcribe.py`, `beats.py`, `engine_io.py`): log lỗi, không dò
 *   Python+torch, nên máy khai `python: null` và hub không giao `studio.tts` / `studio.transcribe` / `studio.beats`.
 * - Thiếu font OFL đóng kèm (`fonts/`): log lỗi, máy khai mức render ngay dưới `RENDER_FONT_LEVEL`, nên composition dùng
 *   font (và mọi trường mới hơn) không về máy này.
 * - Thiếu Arial: log lỗi (render có chữ sẽ lỗi `fonts_missing`).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDER_FEATURE_LEVEL, RENDER_FONT_LEVEL } from '@ag-studio/render';
import { bundledFontsDir, findArialFiles, missingBundledFonts } from './fonts.js';

/** Các file engine Python mà handler gọi (python-runner.ts, transcribe-handler.ts). */
export const PYTHON_ENGINE_FILES = ['tts.py', 'transcribe.py', 'beats.py', 'engine_io.py'] as const;

/** `engines/python/` của gói (cạnh `dist/`, như tts-handler.ts). */
export function defaultEnginesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'engines', 'python');
}

export interface SelfCheck {
  /** Engine Python thiếu file (rỗng = đủ). */
  missingEngines: string[];
  /** Font đóng kèm thiếu (rỗng = đủ). */
  missingFonts: string[];
  arial: boolean;
  /** Python dò được hay không: false khi thiếu file engine. */
  python: boolean;
  /** Mức render máy khai với farm (`engines.studio_render`). */
  studioRender: number;
  /** Từng vấn đề, một câu (rỗng = máy đủ). */
  problems: string[];
}

export function selfCheck(o: { enginesDir?: string; bundledDir?: string; fontsDir?: string } = {}): SelfCheck {
  const enginesDir = o.enginesDir ?? defaultEnginesDir();
  const missingEngines = PYTHON_ENGINE_FILES.filter((f) => !existsSync(join(enginesDir, f)));
  const missingFonts = missingBundledFonts(o.bundledDir ?? bundledFontsDir());
  const arial = findArialFiles(o.fontsDir).length > 0;
  const problems: string[] = [];
  if (missingEngines.length > 0) {
    problems.push(`thiếu engine Python ${missingEngines.join(', ')} trong ${enginesDir}: máy không nhận studio.tts / studio.transcribe / studio.beats (cài lại bản mới nhất)`);
  }
  if (missingFonts.length > 0) {
    problems.push(`thiếu font ${missingFonts.join(', ')} (fonts/ của bản phát hành): máy khai mức render ${RENDER_FONT_LEVEL - 1} thay vì ${RENDER_FEATURE_LEVEL} (cài lại bản mới nhất)`);
  }
  if (!arial) problems.push('không tìm thấy Arial: render có chữ sẽ lỗi fonts_missing (Windows: C:\\Windows\\Fonts\\arial.ttf; Linux: ttf-mscorefonts-installer; hoặc extra.fonts_dir)');
  return {
    missingEngines,
    missingFonts,
    arial,
    python: missingEngines.length === 0,
    studioRender: missingFonts.length > 0 ? Math.min(RENDER_FEATURE_LEVEL, RENDER_FONT_LEVEL - 1) : RENDER_FEATURE_LEVEL,
    problems,
  };
}
