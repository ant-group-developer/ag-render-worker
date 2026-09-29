/**
 * Arial cho chữ và phụ đề burn vào video.
 *
 * Giấy phép Arial không cho chép file font vào repo hay bucket, nên worker lấy Arial đã cài trên máy:
 * Windows có sẵn trong `%WINDIR%\Fonts`, Linux cài gói `ttf-mscorefonts-installer`. Chỉ các file Arial
 * được chép sang một thư mục riêng của job rồi đưa cho libass (`fontsdir`), để libass không phải quét cả
 * thư mục font của hệ thống và không lấy nhầm font khác khi thiếu Arial.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Tên file Arial thường gặp (không phân biệt hoa thường): thường, đậm, nghiêng, đậm nghiêng. */
const ARIAL_FILE = /^arial(bd|i|bi|_bold|_italic|_bold_italic)?\.ttf$/i;

/** Thư mục font mặc định theo hệ điều hành, xét theo thứ tự. */
export function defaultFontDirs(): string[] {
  if (process.platform === 'win32') {
    const winDir = process.env['WINDIR'] ?? 'C:\\Windows';
    const dirs = [join(winDir, 'Fonts')];
    if (process.env['LOCALAPPDATA']) dirs.push(join(process.env['LOCALAPPDATA'], 'Microsoft', 'Windows', 'Fonts'));
    return dirs;
  }
  if (process.platform === 'darwin') return ['/Library/Fonts', '/System/Library/Fonts/Supplemental'];
  return ['/usr/share/fonts/truetype/msttcorefonts', '/usr/share/fonts/truetype', '/usr/local/share/fonts'];
}

/** Các file Arial tìm được (đường dẫn đầy đủ). Thư mục cấu hình `fontsDir` được xét trước. */
export function findArialFiles(fontsDir?: string): string[] {
  const dirs = fontsDir ? [fontsDir] : defaultFontDirs();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const hits = names.filter((n) => ARIAL_FILE.test(n)).map((n) => join(dir, n));
    // Phải có ít nhất bản thường; bản đậm dùng cho tiêu đề, thiếu thì libass tự làm đậm.
    if (hits.some((p) => /arial\.ttf$/i.test(p))) return hits;
  }
  return [];
}

export class ArialMissingError extends Error {
  constructor(fontsDir?: string) {
    super(
      fontsDir
        ? `Không tìm thấy arial.ttf trong fonts_dir "${fontsDir}"`
        : `Không tìm thấy Arial trong ${defaultFontDirs().join(', ')}. Windows: kiểm tra C:\\Windows\\Fonts\\arial.ttf; ` +
            'Linux: cài ttf-mscorefonts-installer; hoặc đặt extra.fonts_dir trong config',
    );
    this.name = 'ArialMissingError';
  }
}

/** Chép Arial vào `destDir` và trả `destDir`; ném `ArialMissingError` khi máy không có Arial. */
export function prepareArialDir(destDir: string, fontsDir?: string): string {
  const files = findArialFiles(fontsDir);
  if (files.length === 0) throw new ArialMissingError(fontsDir);
  mkdirSync(destDir, { recursive: true });
  for (const f of files) copyFileSync(f, join(destDir, f.split(/[\\/]/).pop()!));
  return destDir;
}
