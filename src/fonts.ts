/**
 * Font cho chữ và phụ đề burn vào video.
 *
 * - Arial: giấy phép không cho chép file font vào repo hay bucket, nên worker lấy Arial đã cài trên máy: Windows có sẵn
 *   trong `%WINDIR%\Fonts`, Linux cài gói `ttf-mscorefonts-installer`.
 * - Font OFL đóng kèm bản phát hành (`fonts/`, danh sách ở `fonts/fonts.json`, Studio `TEXT_FONTS`): 43 họ font (6 từ mức
 *   render 4, 37 từ mức 8). Chữ thuộc bộ chữ font của kênh không có thì vẽ bằng Noto Sans KR/JP hoặc Be Vietnam Pro.
 *
 * Mỗi job chỉ chép đúng các font composition cần sang một thư mục riêng rồi đưa cho libass (`fontsdir`), để libass không
 * phải quét cả thư mục font của hệ thống và không lấy nhầm font khác.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tên file Arial thường gặp (không phân biệt hoa thường): thường, đậm, nghiêng, đậm nghiêng. */
const ARIAL_FILE = /^arial(bd|i|bi|_bold|_italic|_bold_italic)?\.ttf$/i;
const ARIAL = 'Arial';

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

// ---------------------------------------------------------------------------
// Font OFL đóng kèm bản phát hành
// ---------------------------------------------------------------------------

export interface BundledFont {
  family: string;
  license: string;
  license_file: string;
  files: { file: string; url: string; sha256: string | null }[];
}

/** `fonts/` của gói: cạnh `dist/` (bản phát hành: `dist/worker.mjs`; lúc dev: `dist/*.js` hoặc `src/*.ts`). */
export function bundledFontsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
}

/** Danh sách font đóng kèm (`fonts.json`); thư mục không có danh sách = không font nào. */
export function readBundledFonts(dir: string): BundledFont[] {
  const path = join(dir, 'fonts.json');
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { fonts: BundledFont[] }).fonts;
}

/** Font đóng kèm mà thư mục thiếu file (danh sách rỗng = đủ). Không đọc được danh sách thì báo thiếu `fonts.json`. */
export function missingBundledFonts(dir: string): string[] {
  let fonts: BundledFont[];
  try {
    fonts = readBundledFonts(dir);
  } catch {
    return ['fonts.json'];
  }
  if (fonts.length === 0) return ['fonts.json'];
  return fonts.filter((f) => f.files.some((x) => !existsSync(join(dir, x.file)))).map((f) => f.family);
}

export class FontMissingError extends Error {
  constructor(readonly families: string[]) {
    super(`Máy render thiếu font ${families.join(', ')} (thư mục fonts/ của bản phát hành ag-render-worker): cài lại bản mới nhất`);
    this.name = 'FontMissingError';
  }
}

/**
 * Chép vào `destDir` các font cho `families` (Studio `studioFontFamilies`): Arial của máy (luôn chép khi máy có, vì đó
 * là font mặc định; thiếu mà cần thì `ArialMissingError`) và file của các font đóng kèm (thiếu thì `FontMissingError`).
 */
export function prepareFontsDir(destDir: string, o: { families: readonly string[]; fontsDir?: string; bundledDir?: string }): string {
  mkdirSync(destDir, { recursive: true });
  const arial = findArialFiles(o.fontsDir);
  if (arial.length === 0 && o.families.includes(ARIAL)) throw new ArialMissingError(o.fontsDir);
  for (const f of arial) copyFileSync(f, join(destDir, f.split(/[\\/]/).pop()!));

  const bundledDir = o.bundledDir ?? bundledFontsDir();
  let bundled: BundledFont[] = [];
  try {
    bundled = readBundledFonts(bundledDir);
  } catch {
    bundled = [];
  }
  const missing: string[] = [];
  for (const family of o.families) {
    if (family === ARIAL) continue;
    const font = bundled.find((f) => f.family === family);
    if (!font || font.files.some((x) => !existsSync(join(bundledDir, x.file)))) {
      missing.push(family);
      continue;
    }
    for (const x of font.files) copyFileSync(join(bundledDir, x.file), join(destDir, x.file));
  }
  if (missing.length > 0) throw new FontMissingError(missing);
  return destDir;
}
