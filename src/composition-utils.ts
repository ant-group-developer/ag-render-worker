/**
 * Tiện ích xử lý composition:
 * - Thu thập tên input được tham chiếu trong composition
 * - Ghi đè đường dẫn thành path cục bộ
 * - Tính khoảng cắt có handle (range-cut math)
 */

// ---- Kiểu composition tối giản (tương thích CompositionSchema) ----
// Không import trực tiếp CompositionSchema từ @harness/contracts vì nó là ESM deep import
// Dùng kiểu cục bộ, validate bằng zod nếu cần.

export interface CompositionSegment {
  order: number;
  source_id: string;
  source_path: string;  // tên input logic, ví dụ `segment:<id>`
  in: number;
  out: number;
  start: number;
  end: number;
  fit: 'scale_pad' | 'scale_crop';
  has_audio: boolean;
  transition_out: {
    kind: string;
    seconds: number;
    tail_available: boolean;
  };
}

export interface CompositionNarration {
  line_id: string;
  wav: string;   // tên input logic, ví dụ `stage:tts/L001.wav`
  start: number;
  end: number;
}

export interface CompositionMusic {
  track_id: string;
  path: string;  // tên input logic, ví dụ `library:music/track.mp3`
  loop: boolean;
  fade_in: number;
  fade_out: number;
  cues: unknown[];
  duck: unknown;
}

export interface CompositionLogo {
  path: string;  // tên input logic
  corner: string;
  opacity: number;
  height_px: number;
}

export interface CompositionBrand {
  channel_id: string;
  revision: number;
  /** Tên input logic cho thư mục brand, ví dụ `library:brands/channel1` */
  dir: string;
  /** Tên input logic cho thư mục fonts */
  fonts_dir: string;
  checksums: Record<string, string>;
}

export interface Composition {
  schema_version: string;
  output: {
    width: number;
    height: number;
    fps: number;
    codec: string;
  };
  voice: string;
  language: string;
  total_seconds: number;
  request_id: string;
  brand: CompositionBrand | null;
  segments: CompositionSegment[];
  text_events: unknown[];
  captions: unknown;
  music: CompositionMusic | null;
  music_reason?: string;
  logo: CompositionLogo | null;
  narration: CompositionNarration[];
  transitions: unknown;
  text_dropped?: unknown[];
  warnings: string[];
  [key: string]: unknown;
}

// ---- Thu thập input names ----

/**
 * Thu thập tất cả tên input logic được tham chiếu trong composition.
 * Các trường đường dẫn: segment source_path, narration wav, music.path,
 * logo.path, brand.dir, brand.fonts_dir.
 */
export function collectCompositionInputs(composition: Composition): Set<string> {
  const inputs = new Set<string>();

  for (const seg of composition.segments) {
    if (seg.source_path) inputs.add(seg.source_path);
  }

  for (const line of composition.narration) {
    if (line.wav) inputs.add(line.wav);
  }

  if (composition.music?.path) {
    inputs.add(composition.music.path);
  }

  if (composition.logo?.path) {
    inputs.add(composition.logo.path);
  }

  if (composition.brand) {
    if (composition.brand.dir) inputs.add(composition.brand.dir);
    if (composition.brand.fonts_dir) inputs.add(composition.brand.fonts_dir);
  }

  return inputs;
}

// ---- Ghi đè đường dẫn ----

/**
 * Tạo bản sao composition với mọi tên input logic được thay bằng path cục bộ.
 * Các input không có trong map sẽ giữ nguyên giá trị (cảnh báo nên ghi log).
 */
export function rewriteCompositionPaths(
  composition: Composition,
  inputToLocal: Map<string, string>,
): Composition {
  const rewrite = (name: string): string => inputToLocal.get(name) ?? name;

  const newSegments: CompositionSegment[] = composition.segments.map((seg) => ({
    ...seg,
    source_path: rewrite(seg.source_path),
  }));

  const newNarration: CompositionNarration[] = composition.narration.map((line) => ({
    ...line,
    wav: rewrite(line.wav),
  }));

  let newMusic = composition.music;
  if (newMusic) {
    newMusic = { ...newMusic, path: rewrite(newMusic.path) };
  }

  let newLogo = composition.logo;
  if (newLogo) {
    newLogo = { ...newLogo, path: rewrite(newLogo.path) };
  }

  let newBrand = composition.brand;
  if (newBrand) {
    newBrand = {
      ...newBrand,
      dir: rewrite(newBrand.dir),
      fonts_dir: rewrite(newBrand.fonts_dir),
    };
  }

  return {
    ...composition,
    segments: newSegments,
    narration: newNarration,
    music: newMusic,
    logo: newLogo,
    brand: newBrand,
  };
}

