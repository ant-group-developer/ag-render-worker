/**
 * Handler studio.render_preview và studio.render_final:
 * Tải composition → thu thập input → download asset inputs → probe/clamp →
 * gọi renderComposition → upload output → (render_final) render thumbnails → (payload.inspect) tự kiểm bản render và
 * upload inspect.json + sheet-NN.jpg → upload render.json.
 *
 * GĐ2: footage clips dùng `asset:<id>` (toàn bộ file gốc, không cắt). `segment:` không còn hỗ trợ.
 */
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, relative } from 'node:path';
import {
  StudioRenderPayloadSchema,
  RenderManifestSchema,
  RENDER_MANIFEST_SCHEMA,
  RENDER_MANIFEST_PATH,
  RENDER_INSPECT_PATH,
  thumbnailOutputPath,
} from '@ag-farm/protocol';
import type { JobResult, SignResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import type { RenderDeps, RenderInput } from '@ag-studio/render';
import { renderComposition, probeNvenc, CompositionSchema, studioFontFamilies, studioOverlayAss, inspectRender } from '@ag-studio/render';
import type { Composition } from './composition-utils.js';
import {
  collectCompositionInputs,
  rewriteCompositionPaths,
} from './composition-utils.js';
import { probeMedia, runFfmpeg, resolveFfmpeg, resolveFfprobe, type MediaProbeResult } from './ffmpeg-utils.js';
import type { RenderWorkerExtra } from './config.js';
import { ArialMissingError, FontMissingError, bundledFontsDir, missingBundledFonts, prepareArialDir, prepareFontsDir } from './fonts.js';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A `src_<ULID>`-shaped id unique to one clip of the composition, stable for the same input. */
export function clipSourceId(sourceId: string, index: number): string {
  const bytes = createHash('sha256').update(`${sourceId}#${index}`).digest();
  let id = CROCKFORD[bytes[0]! % 8]!;
  for (let i = 1; i < 26; i++) id += CROCKFORD[bytes[i]! % 32]!;
  return `src_${id}`;
}

/** How far either stream of a finished render may sit from the composition's `total_seconds`. */
export const DURATION_TOLERANCE_S = 0.5;

/**
 * `duration_mismatch:<expected>:<actual>` when the video or the audio stream of a finished render is more than
 * `DURATION_TOLERANCE_S` off `total_seconds` (the stream furthest off is named), else `null`. Studio reads it as
 * an error of the render: a preview that ended at 13:23 of a 17:30 timeline went out with only a duration line.
 */
export function durationMismatch(expected: number, streams: { video_seconds: number | null; audio_seconds: number | null }): string | null {
  const measured = [streams.video_seconds, streams.audio_seconds].filter((s): s is number => s !== null);
  if (measured.length === 0) return null;
  const worst = measured.reduce((a, b) => (Math.abs(b - expected) > Math.abs(a - expected) ? b : a));
  if (Math.abs(worst - expected) <= DURATION_TOLERANCE_S) return null;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return `duration_mismatch:${r3(expected)}:${r3(worst)}`;
}

// ---- Cache mezzanine (dựa trên file system) ----

const GB = 1024 * 1024 * 1024;
const DEFAULT_MEZZ_CACHE_GB = 20;
/** Mezzanine dựng cùng lúc khi config không khai `mezz_concurrency`. */
export const DEFAULT_MEZZ_CONCURRENCY = 3;
/**
 * File nguồn tải cùng lúc khi config không khai `download_concurrency`. Máy farm đã chạy gần kịch cổng 1 Gbit với một
 * luồng tải: luồng thứ hai chủ yếu để file sau không phải đợi file trước xong mới bắt đầu.
 */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 2;
/**
 * Lượt ghép cuối khi config không khai gì: đoạn chừng 14 clip, 3 đoạn cùng lúc, 8 luồng giải mã mỗi clip. Đo ở máy dev
 * trên bản 127 clip 4K (giải mã 16 luồng như máy farm): ffmpeg 6.1 ghép 3 đoạn lớn cùng lúc thì hết bộ nhớ; 9 đoạn,
 * 3 cùng lúc, 8 luồng xong trong 194 s với 15 GB (ffmpeg 9: 5 GB), một lượt ffmpeg 9 mất 345 s với 20 GB.
 */
export const DEFAULT_FINAL_SLICE_INPUTS = 14;
export const DEFAULT_FINAL_CONCURRENCY = 3;
export const DEFAULT_DECODE_THREADS = 8;

/**
 * Thư mục cache mezzanine dùng chung giữa các job khi config có `mezz_cache_dir` (main.ts đặt mặc định
 * cạnh thư mục cache của SDK), nên "Render lại" một tập không phải chuẩn hoá lại các video đã chuẩn hoá.
 * Không có thì cache nằm trong thư mục job như trước (test).
 */
function makeMezzCache(extra: RenderWorkerExtra, workDir: string): RenderDeps['cache'] {
  const dir = extra.mezz_cache_dir ?? join(workDir, 'mezz_cache');
  mkdirSync(dir, { recursive: true });
  return { dir, maxBytes: (extra.mezz_cache_gb ?? DEFAULT_MEZZ_CACHE_GB) * GB };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ---- Tạo ASS subtitle đơn giản cho thumbnail ----

/**
 * Tạo nội dung file .ass cho thumbnail: chữ trắng đậm, viền đen, căn giữa dưới.
 * Text dài sẽ được ASS tự ngắt dòng (WrapStyle: 1 = smart wrap).
 */
export function buildThumbnailAss(text: string, width: number, height: number): string {
  // Thumbnail text is read at phone size in a feed: big, bold, thick outline and a shadow (texts are at most
  // 40 characters; WrapStyle 1 breaks a long one over two lines).
  const fontSize = Math.round(Math.min(width, height) * 0.12);
  const outline = Math.max(4, Math.round(fontSize * 0.1));
  const shadow = Math.max(2, Math.round(fontSize * 0.04));
  const marginV = Math.round(height * 0.06);
  const marginH = Math.round(width * 0.05);
  return (
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    `PlayResX: ${width}\n` +
    `PlayResY: ${height}\n` +
    'WrapStyle: 1\n' +
    'ScaledBorderAndShadow: yes\n' +
    '\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: Thumb,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginH},${marginH},${marginV},1\n` +
    '\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    `Dialogue: 0,0:00:00.00,999:59:59.99,Thumb,,0,0,0,,${text.replace(/\n/g, '\\N')}\n`
  );
}

/**
 * Tạo danh sách args ffmpeg để render một thumbnail:
 * extract frame tại t_s (đã clamp), scale+crop, đốt ASS subtitle, lưu JPEG.
 *
 * IMPORTANT (Windows): `assPath` and `fontsDir` are embedded in the ffmpeg
 * filtergraph string where `:` acts as option separator.  Callers MUST pass
 * paths that contain no `:` (i.e. relative paths or Unix-style paths without
 * a drive letter).  In practice: call `runFfmpeg` with `cwd` set to the
 * working directory and pass basenames / relative paths for these two options.
 *
 * @param fontsDir - thư mục chứa Arial TTF (tuỳ chọn; libass dùng để hiển thị chữ)
 */
export function buildThumbnailFfmpegArgs(opts: {
  videoPath: string;
  t_s: number;
  assPath: string;
  fontsDir: string | null;
  targetWidth: number;
  targetHeight: number;
  outputPath: string;
}): string[] {
  const assFilter = opts.fontsDir
    ? `ass=${opts.assPath}:fontsdir=${opts.fontsDir}`
    : `ass=${opts.assPath}`;

  return [
    '-ss', String(opts.t_s),
    '-i', opts.videoPath,
    '-frames:v', '1',
    '-vf', [
      `scale=w=${opts.targetWidth}:h=${opts.targetHeight}:force_original_aspect_ratio=increase`,
      `crop=${opts.targetWidth}:${opts.targetHeight}`,
      assFilter,
    ].join(','),
    '-q:v', '2',
    '-y',
    opts.outputPath,
  ];
}

// ---- Thời gian từng bước ----

/** Số giây (3 chữ số lẻ) từ `startMs` tới giờ. */
function secondsSince(startMs: number): number {
  return Math.round(Date.now() - startMs) / 1000;
}

/**
 * Thời gian từng bước của một job render và vài con số đi kèm, ghi phẳng vào `summary` của kết quả job (farm hiện
 * trong chi tiết job): `t_<bước>_s` là số giây thật của bước đó; `t_source_wait_s` là lúc các luồng dựng mezzanine
 * đứng chờ file nguồn còn đang tải. Bước không chạy (preview không có thumbnail, job không tự kiểm) là 0.
 */
export interface RenderJobTimings {
  t_sign_s: number;
  t_download_s: number;
  t_mezz_s: number;
  t_source_wait_s: number;
  t_even_s: number;
  t_loudnorm_s: number;
  t_final_encode_s: number;
  t_upload_s: number;
  t_thumbnails_s: number;
  t_inspect_s: number;
  t_total_s: number;
}

// ---- Handler chính ----

type RenderKind = 'render_preview' | 'render_final';

async function handleStudioRender(
  ctx: JobContext,
  kind: RenderKind,
  extra: RenderWorkerExtra = {},
): Promise<JobResult> {
  // 1. Validate payload
  const payloadResult = StudioRenderPayloadSchema.safeParse(ctx.payload);
  if (!payloadResult.success) {
    throw new NonRetryableError(
      'invalid_payload',
      `Invalid ${kind} payload: ${payloadResult.error.message}`,
    );
  }
  const payload = payloadResult.data;

  const log = ctx.log.child({ handler: `studio.${kind}`, production_id: payload.production_id });
  log.info(`Starting studio.${kind}`, { revision: payload.revision });
  const jobStarted = Date.now();
  const t: RenderJobTimings = {
    t_sign_s: 0, t_download_s: 0, t_mezz_s: 0, t_source_wait_s: 0, t_even_s: 0, t_loudnorm_s: 0, t_final_encode_s: 0,
    t_upload_s: 0, t_thumbnails_s: 0, t_inspect_s: 0, t_total_s: 0,
  };
  /** Byte của các file nguồn job này dựng từ (tải về hoặc lấy từ cache của SDK). */
  let sourceBytes = 0;

  const workDir = ctx.workDir;
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const ffmpegTimeoutMs = (extra.ffmpeg_timeout_s ?? 3600) * 1000;
  const isPreview = kind === 'render_preview';

  ctx.progress(2, 'download_composition');

  // 2. Download composition JSON
  const compositionPath = join(workDir, 'composition.json');
  await ctx.download(payload.composition, compositionPath);

  const { readFileSync } = await import('node:fs');
  const rawJson = JSON.parse(readFileSync(compositionPath, 'utf8'));
  const compositionResult = CompositionSchema.safeParse(rawJson);
  if (!compositionResult.success) {
    throw new NonRetryableError(
      'invalid_composition',
      `Composition JSON is invalid: ${compositionResult.error.message}`,
    );
  }
  const composition = compositionResult.data as unknown as Composition;

  ctx.progress(5, 'collect_inputs');

  // 3. Thu thập tên input
  const inputNames = collectCompositionInputs(composition);

  // Phân loại: asset inputs vs. các input khác
  const assetInputs: string[] = [];
  const otherInputs: string[] = [];
  for (const name of inputNames) {
    if (name.startsWith('asset:')) {
      assetInputs.push(name);
    } else {
      otherInputs.push(name);
    }
  }

  const inputToLocal = new Map<string, string>();
  const sourceMetas = new Map<string, {
    source_kind: 'original' | 'proxy' | 'preview';
    watermarked: boolean;
  }>();

  ctx.progress(8, 'sign_assets');

  // 4. Sign (metadata only) rồi tải asset inputs, song song và theo thứ tự đoạn đầu tiên dùng tới, trong lúc dựng.
  //
  // Asset inputs là toàn bộ file video (Studio gửi in: 0, out: <duration từ analysis>). Mỗi asset tải một lần qua
  // ctx.download (cache + file:// của SDK). Đường dẫn cục bộ tính sẵn, nên composition được viết lại ngay; mỗi đoạn chờ
  // đúng file của nó (`sourceFor`), nên đoạn đầu dựng trong khi các file sau còn đang tải.
  const assetsDir = join(workDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const assetCacheKey = new Map<string, string | null>();
  if (assetInputs.length > 0) {
    const signOps = assetInputs.map((name) => ({ op: 'get' as const, input: name }));
    const signStarted = Date.now();
    const signResults: SignResult[] = await ctx.sign.sign(signOps);
    t.t_sign_s = secondsSince(signStarted);
    for (let i = 0; i < assetInputs.length; i++) {
      const inputName = assetInputs[i]!;
      const signResult = signResults[i];
      if (!signResult || signResult.op !== 'get') {
        throw new Error(`Unexpected sign result for ${inputName}`);
      }
      sourceMetas.set(inputName, {
        source_kind: signResult.source?.source_kind ?? 'preview',
        watermarked: signResult.source?.watermarked ?? true,
      });
      assetCacheKey.set(inputName, signResult.cache_key);
      // Đường dẫn cục bộ: dùng safeId cho file (không cache-keyed qua SDK)
      inputToLocal.set(inputName, join(assetsDir, `${inputName.replace(/[^a-zA-Z0-9._-]/g, '_')}.mp4`));
    }
  }

  /**
   * Một asset đã nằm trên đĩa: độ dài probe được (null nếu probe hỏng), có luồng tiếng hay không (null nếu probe hỏng)
   * và danh tính gộp vào khoá cache mezzanine.
   */
  type AssetReady = { path: string; duration: number | null; hasAudio: boolean | null; checksum: string };
  const downloadConcurrency = extra.download_concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY;
  const assetsByFirstUse = [...new Set(
    [...composition.segments].sort((a, b) => a.order - b.order).map((seg) => seg.source_path).filter((p) => assetInputs.includes(p)),
  )];
  for (const name of assetInputs) if (!assetsByFirstUse.includes(name)) assetsByFirstUse.push(name);
  const assetReady = new Map<string, Promise<AssetReady>>();
  const queue: { name: string; resolve: (r: AssetReady) => void; reject: (e: unknown) => void }[] = [];
  for (const name of assetsByFirstUse) {
    let resolve!: (r: AssetReady) => void;
    let reject!: (e: unknown) => void;
    const ready = new Promise<AssetReady>((res, rej) => { resolve = res; reject = rej; });
    ready.catch(() => {}); // một lượt tải hỏng được báo qua đoạn chờ nó, không thành unhandled rejection
    assetReady.set(name, ready);
    queue.push({ name, resolve, reject });
  }
  let downloadsStopped = false;
  let assetsDone = 0;
  let renderPercent = 0;
  let renderStage: string | null = null;
  /** Một dải tiến độ cho cả tải lẫn dựng (chạy chồng lên nhau): 25% theo số asset đã tải, 75% theo phần dựng. */
  const reportCombined = (): void => {
    const dl = assetsByFirstUse.length > 0 ? assetsDone / assetsByFirstUse.length : 1;
    ctx.progress(Math.round(8 + 81 * (0.25 * dl + 0.75 * (renderPercent / 100))), renderStage ?? 'download_assets');
  };
  const fetchAsset = async (name: string): Promise<AssetReady> => {
    const localPath = inputToLocal.get(name)!;
    const cacheKey = assetCacheKey.get(name) ?? null;
    if (!(await fileExists(localPath))) {
      // ctx.download handles cache lookup, file:// in tests, and HTTP in production
      await ctx.download(name, localPath, { useCacheKey: cacheKey });
    }
    sourceBytes += statSync(localPath).size;
    let duration: number | null = null;
    let hasAudio: boolean | null = null;
    try {
      const probed = await probeMedia(localPath, ffprobe);
      duration = probed.duration_seconds;
      hasAudio = probed.has_audio;
    } catch (e) {
      log.warn('Failed to probe asset, skipping clamp', { input: name, error: String(e) });
    }
    /**
     * Nội dung của input, gộp vào khoá cache mezzanine: `cache_key` ag-go cấp (original:/proxy:/variant: theo id, đổi
     * khi file đổi) hoặc sha256 của file. Không dùng đường dẫn cục bộ: nó khác nhau ở mỗi job.
     */
    const checksum = cacheKey ? `cache_key:${cacheKey}` : `sha256:${await sha256File(localPath)}`;
    return { path: localPath, duration, hasAudio, checksum };
  };
  const downloadStarted = Date.now();
  const downloadLane = async (): Promise<void> => {
    while (!downloadsStopped && queue.length > 0) {
      const item = queue.shift()!;
      try {
        item.resolve(await fetchAsset(item.name));
        assetsDone++;
        reportCombined();
      } catch (e) {
        // không mở lượt tải mới; những đoạn chờ các file chưa tải cũng hỏng theo
        downloadsStopped = true;
        item.reject(e);
        for (const rest of queue.splice(0)) rest.reject(e);
        return;
      }
    }
  };
  void Promise.all(Array.from({ length: Math.min(downloadConcurrency, queue.length) }, downloadLane))
    .then(() => { t.t_download_s = Math.round((t.t_download_s + secondsSince(downloadStarted)) * 1000) / 1000; });

  // 5. Download các input khác (stage:, library:): lời dẫn, nhạc, logo, nhỏ, cần trước lượt ghép cuối
  const otherStarted = Date.now();
  for (let i = 0; i < otherInputs.length; i++) {
    const name = otherInputs[i]!;
    if (name.startsWith('stage:') || name.startsWith('library:')) {
      const ext = name.includes('.') ? name.split('.').pop() ?? 'bin' : 'bin';
      const localName = name.replace(/[^a-zA-Z0-9.]/g, '_');
      const localPath = join(workDir, `input_${localName}.${ext}`);
      const localDir = dirname(localPath);
      mkdirSync(localDir, { recursive: true });
      try {
        await ctx.download(name, localPath);
        inputToLocal.set(name, localPath);
      } catch (e) {
        log.info('Could not download input, skipping', { name, error: String(e) });
      }
    }
  }
  t.t_download_s = Math.round((t.t_download_s + secondsSince(otherStarted)) * 1000) / 1000;

  // 6. Ghi đè đường dẫn composition
  const localComposition = rewriteCompositionPaths(composition, inputToLocal);

  // 7. Chuẩn bị renderComposition
  const outDir = join(workDir, 'render_out');
  mkdirSync(outDir, { recursive: true });

  /** Input gốc (`asset:<id>`) của từng đoạn theo `order`: `localComposition` đã mang đường dẫn cục bộ. */
  const inputByOrder = new Map(composition.segments.map((seg) => [seg.order, seg.source_path]));
  /** Checksum của nguồn không phải asset (đã tải ở bước 5), tính một lần mỗi file. */
  const otherChecksums = new Map<string, Promise<string>>();
  const CLAMP_TOLERANCE_S = 0.5;
  const clampWarned = new Set<string>();
  /** Đoạn mà composition đòi tiếng nhưng file nguồn không có luồng tiếng: dựng câm, lượt tự kiểm cũng coi là câm. */
  const silentOrders = new Set<number>();
  /**
   * Nguồn của một đoạn, chờ tới khi file của nó tải xong. `out` bị cắt về độ dài probe được khi file ngắn hơn timeline
   * (cảnh báo khi lệch quá 0,5 s): đoạn đó giữ khung cuối, file ra vẫn dài đúng composition. File không có luồng tiếng
   * thì `has_audio: false`: map `[0:a]` của nó làm hỏng cả mezzanine ("matches no streams"), nên đoạn đó dựng câm.
   */
  const sourceFor = async (seg: { order: number; source_path: string; in: number; out: number; has_audio: boolean }) => {
    const input = inputByOrder.get(seg.order) ?? seg.source_path;
    const ready = assetReady.get(input);
    if (ready === undefined) {
      const local = inputToLocal.get(input);
      if (!otherChecksums.has(input)) otherChecksums.set(input, local ? sha256File(local).then((h) => `sha256:${h}`) : Promise.resolve(`input:${input}`));
      return { path: seg.source_path, checksum: await otherChecksums.get(input)!, out: seg.out };
    }
    const asset = await ready;
    let out = seg.out;
    if (asset.duration !== null && seg.out > asset.duration) {
      if (seg.out - asset.duration > CLAMP_TOLERANCE_S && !clampWarned.has(`${input}@${seg.out}`)) {
        clampWarned.add(`${input}@${seg.out}`);
        const warning = `Asset ${input}: segment out=${seg.out.toFixed(3)}s exceeds probed duration ${asset.duration.toFixed(3)}s by more than ${CLAMP_TOLERANCE_S}s; clamping.`;
        log.warn(warning);
        // Thêm vào warnings của composition (warnings array mutable sau khi parse)
        if (!composition.warnings) (composition as Composition).warnings = [];
        composition.warnings.push(warning);
      }
      out = Math.max(seg.in, asset.duration);
    }
    if (asset.hasAudio === false && seg.has_audio && !silentOrders.has(seg.order)) {
      silentOrders.add(seg.order);
      log.warn(`Asset ${input} has no audio stream; segment ${seg.order} is rendered silent`);
    }
    return { path: asset.path, checksum: asset.checksum, out, ...(asset.hasAudio === false ? { has_audio: false } : {}) };
  };

  const clock = { now: () => new Date().toISOString() };

  const renderDeps: RenderDeps = {
    ffmpeg,
    prober: {
      async probe(p: string) {
        try {
          const info = await probeMedia(p, ffprobe);
          return {
            media: null,
            mime_type: null,
            container: null,
            duration_seconds: info.duration_seconds,
            video: info.width > 0
              ? { codec: 'h264', width: info.width, height: info.height, fps: info.fps ?? 25 }
              : null,
            audio: info.has_audio
              ? { codec: 'aac', channels: 2, sample_rate: 48000 }
              : null,
          };
        } catch {
          return null;
        }
      },
    },
    cache: makeMezzCache(extra, workDir),
    nvencAvailable: async () => {
      try {
        return await probeNvenc(ffmpeg);
      } catch {
        return false;
      }
    },
    clock,
    log: (line: string) => log.info(line),
  };

  // Chữ (track T) và phụ đề: dựng overlay.ass từ composition; font là Arial của máy này và font OFL đóng kèm bản phát
  // hành (xem fonts.ts). Có Noto Sans JP/KR thì chữ Nhật/Hàn vẽ bằng chúng, không thành ô vuông.
  let assPath: string | null = null;
  let fontsDir: string | null = null;
  const studioComposition = localComposition as unknown as import('@ag-studio/render').Composition;
  const bundledDir = extra.bundled_fonts_dir ?? bundledFontsDir();
  const lacking = missingBundledFonts(bundledDir);
  const scriptFonts = !lacking.includes('Noto Sans JP') && !lacking.includes('Noto Sans KR') && !lacking.includes('fonts.json');
  const ass = studioOverlayAss(studioComposition, { scriptFonts });
  if (ass !== null) {
    const families = scriptFonts ? studioFontFamilies(studioComposition) : [studioComposition.text_style?.font ?? 'Arial'];
    try {
      fontsDir = prepareFontsDir(join(workDir, 'fonts'), { families, fontsDir: extra.fonts_dir, bundledDir });
    } catch (e) {
      if (e instanceof ArialMissingError || e instanceof FontMissingError) throw new NonRetryableError('fonts_missing', e.message);
      throw e;
    }
    assPath = join(workDir, 'overlay.ass');
    writeFileSync(assPath, ass, 'utf8');
    log.info('Burning text and subtitles', { fonts_dir: fontsDir, families });
  }

  const renderInput: RenderInput = {
    composition: localComposition as unknown as import('@ag-studio/render').RenderInput['composition'],
    assPath,
    fontsDir,
    outDir,
    encoderCfg: extra.encoder ?? 'auto',
    // a preview is watched in a browser: same frame size, a much lighter encode (the mezzanines and their cache are shared)
    tier: isPreview ? 'preview' : 'final',
    timeoutSeconds: ffmpegTimeoutMs / 1000,
    // every segment's checksum comes from `sourceFor`, once its file is down
    sourceChecksums: new Map(),
    sourceFor,
    mezzConcurrency: extra.mezz_concurrency ?? DEFAULT_MEZZ_CONCURRENCY,
    finalSliceInputs: extra.final_slice_inputs ?? DEFAULT_FINAL_SLICE_INPUTS,
    finalConcurrency: extra.final_concurrency ?? DEFAULT_FINAL_CONCURRENCY,
    decodeThreads: extra.decode_threads ?? DEFAULT_DECODE_THREADS,
    signal: ctx.signal,
    onProgress: (percent, stage) => {
      renderPercent = percent;
      // the first progress is the mezzanine phase starting at 0, before any segment has its file
      if (percent > 0 || stage !== 'mezzanine') renderStage = `render_${stage}`;
      reportCombined();
    },
  };

  log.info('Calling renderComposition', { canvas: `${payload.canvas.width}x${payload.canvas.height}`, mezz_concurrency: renderInput.mezzConcurrency, download_concurrency: downloadConcurrency });

  let rendered: Awaited<ReturnType<typeof renderComposition>>;
  try {
    rendered = await renderComposition(renderDeps, renderInput);
  } finally {
    // a failed render opens no new download (the ones running end on their own, into the SDK cache)
    downloadsStopped = true;
  }
  const { report, episodePath, timings } = rendered;
  t.t_mezz_s = timings.mezz_s;
  t.t_source_wait_s = timings.source_wait_s;
  t.t_even_s = timings.even_s;
  t.t_loudnorm_s = timings.loudnorm_s;
  t.t_final_encode_s = timings.final_encode_s;

  // 8. Upload video output
  const outputRelPath = payload.output;
  const videoStats = statSync(episodePath);

  // Từ 90% đến 99% chạy theo số byte đã tải lên (thanh đứng yên ở 95% suốt mấy phút upload bị tưởng là treo và bị bấm
  // dừng); tên bước là upload khi còn đang tải, là bước kiểm đang chạy khi đã tải xong.
  let uploadedShare = 0;
  let uploadDone = false;
  let checkStage: string | null = null;
  const reportTail = (): void => ctx.progress(90 + Math.floor(9 * uploadedShare), !uploadDone || checkStage === null ? 'upload_video' : checkStage);
  reportTail();

  // Bản 4K cỡ 9 GB tải lên mất hơn 10 phút: probe, thumbnail và tự kiểm (đều chỉ đọc file trên máy) chạy trong lúc đó.
  // Upload hỏng giữa chừng thì báo lỗi sau khi các bước kia xong; trước đó không để thành rejection không ai bắt.
  const uploadStarted = Date.now();
  const uploading = ctx.upload(episodePath, outputRelPath, 'video/mp4', {
    onProgress: (done, total) => {
      const share = total > 0 ? Math.min(1, done / total) : 1;
      const moved = Math.floor(9 * share) !== Math.floor(9 * uploadedShare);
      uploadedShare = share;
      if (moved) reportTail();
    },
  }).then(() => {
    t.t_upload_s = secondsSince(uploadStarted);
    uploadedShare = 1;
    uploadDone = true;
    reportTail();
  });
  uploading.catch(() => {});

  // 9. Probe video kết quả để lấy dims/duration
  let finalWidth = payload.canvas.width;
  let finalHeight = payload.canvas.height;
  let finalDuration = 0;
  /** The episode measured against the composition, stream by stream (`durationMismatch`). */
  let mismatch: string | null = null;
  let episodeProbe: MediaProbeResult | null = null;

  try {
    const probeResult = await probeMedia(episodePath, ffprobe);
    episodeProbe = probeResult;
    finalWidth = probeResult.width || finalWidth;
    finalHeight = probeResult.height || finalHeight;
    finalDuration = probeResult.duration_seconds;
    mismatch = durationMismatch(composition.total_seconds, probeResult);
  } catch {
    finalDuration = report.output.seconds;
  }
  if (mismatch !== null) {
    log.warn('Rendered file is not as long as the composition', { mismatch });
  }

  // 10. Thumbnails (chỉ render_final, khi có thumbnail nào được yêu cầu)
  const thumbnailManifestEntries: Array<{
    output: string;
    t_s: number;
    width: number;
    height: number;
  }> = [];

  if (!isPreview && payload.thumbnails.length > 0) {
    checkStage = 'render_thumbnails';
    reportTail();
    const thumbnailsStarted = Date.now();

    // Xác định kích thước đích: landscape/square → 1280×720, portrait → 720×1280
    const isPortrait = payload.canvas.height > payload.canvas.width;
    const thumbW = isPortrait ? 720 : 1280;
    const thumbH = isPortrait ? 1280 : 720;

    // Chuẩn bị fontsDir cho thumbnails nếu chưa có
    let thumbFontsDir = fontsDir;
    if (!thumbFontsDir) {
      try {
        thumbFontsDir = prepareArialDir(join(workDir, 'fonts'), extra.fonts_dir);
      } catch (e) {
        if (e instanceof ArialMissingError) throw new NonRetryableError('fonts_missing', e.message);
        throw e;
      }
    }

    for (let i = 0; i < payload.thumbnails.length; i++) {
      const thumbSpec = payload.thumbnails[i]!;
      const n = i + 1; // 1-based

      // Clamp t_s vào [0, duration - 0.1]
      const clampedT = Math.min(Math.max(0, thumbSpec.t_s), Math.max(0, finalDuration - 0.1));

      const thumbOutputRel = thumbnailOutputPath(outputRelPath, n);
      const thumbLocalPath = join(workDir, `thumb-${n}.jpg`);

      // Tạo ASS file cho thumbnail
      const thumbAss = buildThumbnailAss(thumbSpec.text, thumbW, thumbH);
      const thumbAssPath = join(workDir, `thumb-${n}.ass`);
      writeFileSync(thumbAssPath, thumbAss, 'utf8');

      log.info('Rendering thumbnail', { n, t_s: clampedT, text: thumbSpec.text, size: `${thumbW}x${thumbH}` });

      // Use basename / relative paths for assPath and fontsDir so they are
      // colon-free in the filtergraph (Windows drive letters contain `:` which
      // the ffmpeg option parser treats as option separator).  The cwd is set
      // to workDir so ffmpeg resolves relative paths from there.
      const thumbAssRel = basename(thumbAssPath);
      const thumbFontsDirRel = thumbFontsDir ? relative(workDir, thumbFontsDir) : null;

      const thumbArgs = buildThumbnailFfmpegArgs({
        videoPath: episodePath,
        t_s: clampedT,
        assPath: thumbAssRel,
        fontsDir: thumbFontsDirRel,
        targetWidth: thumbW,
        targetHeight: thumbH,
        outputPath: thumbLocalPath,
      });

      try {
        await runFfmpeg(ffmpeg, thumbArgs, { timeoutMs: ffmpegTimeoutMs, signal: ctx.signal, cwd: workDir });
      } catch (e) {
        throw new Error(`Thumbnail ${n} failed: ${String(e)}`);
      }

      // Upload thumbnail
      await ctx.upload(thumbLocalPath, thumbOutputRel, 'image/jpeg');

      thumbnailManifestEntries.push({
        output: thumbOutputRel,
        t_s: clampedT,
        width: thumbW,
        height: thumbH,
      });
    }
    t.t_thumbnails_s = secondsSince(thumbnailsStarted);
  }

  // 10b. Tự kiểm (payload.inspect): đứng hình, màn đen, im lặng, độ to từng đoạn, tờ ghép khung hình. Lỗi của lượt kiểm
  // không làm hỏng bản render đã upload: manifest chỉ thiếu `inspect` và có cảnh báo `inspect_failed`.
  let inspectEntry: { output: string; sheets: string[] } | undefined;
  const inspectWarnings: string[] = [];
  if (payload.inspect) {
    checkStage = 'inspect';
    reportTail();
    const inspectStarted = Date.now();
    try {
      const { inspection, sheets } = await inspectRender(
        { ffmpeg, clock },
        {
          episodePath,
          composition: {
            ...composition,
            segments: composition.segments.map((s) => (silentOrders.has(s.order) ? { ...s, has_audio: false } : s)),
          } as unknown as import('@ag-studio/render').Composition,
          outDir: join(workDir, 'inspect'),
          hasAudio: episodeProbe?.has_audio ?? true,
          videoSeconds: episodeProbe?.video_seconds ?? null,
          audioSeconds: episodeProbe?.audio_seconds ?? null,
          timeoutSeconds: ffmpegTimeoutMs / 1000,
          signal: ctx.signal,
        },
      );
      for (const sheet of sheets) await ctx.upload(sheet, basename(sheet), 'image/jpeg');
      await ctx.uploadJson(RENDER_INSPECT_PATH, inspection);
      inspectEntry = { output: RENDER_INSPECT_PATH, sheets: sheets.map((sheet) => basename(sheet)) };
      log.info('Inspected the render', { issues: inspection.issues.length, sheets: sheets.length, seconds: inspection.inspect_seconds });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      log.warn('Could not inspect the render', { error: String(e) });
      inspectWarnings.push('inspect_failed');
    }
    t.t_inspect_s = secondsSince(inspectStarted);
  }

  checkStage = null;
  reportTail();
  await uploading;

  ctx.progress(99, 'upload_manifest');

  // 11. Build render manifest
  const anyWatermarked = [...sourceMetas.values()].some((m) => m.watermarked);
  const sources = [...sourceMetas.entries()].map(([input, meta]) => ({
    input,
    source_kind: meta.source_kind,
    watermarked: meta.watermarked,
  }));

  // Merge clamp/pre-render warnings from composition with render warnings
  const allWarnings = [
    ...(composition.warnings ?? []),
    ...(report.warnings ?? []),
    ...(mismatch !== null ? [mismatch] : []),
    ...inspectWarnings,
  ];

  const renderManifest = RenderManifestSchema.parse({
    schema: RENDER_MANIFEST_SCHEMA,
    production_id: payload.production_id,
    revision: payload.revision,
    output: outputRelPath,
    width: finalWidth,
    height: finalHeight,
    duration_s: finalDuration,
    size_bytes: videoStats.size,
    watermarked: anyWatermarked,
    sources,
    warnings: allWarnings,
    thumbnails: thumbnailManifestEntries,
    ...(inspectEntry !== undefined ? { inspect: inspectEntry } : {}),
  });

  await ctx.uploadJson(RENDER_MANIFEST_PATH, renderManifest);
  t.t_total_s = secondsSince(jobStarted);

  const stats = {
    ...t,
    encoder: report.encoder,
    source_gb: Math.round(sourceBytes / 1e7) / 100,
    mezz_rendered: report.segments.rendered,
    mezz_cached: report.segments.cached,
    mezz_concurrency: renderInput.mezzConcurrency ?? 1,
    download_concurrency: downloadConcurrency,
    final_slices: timings.final_slices,
    final_slice_inputs: renderInput.finalSliceInputs ?? 0,
    final_concurrency: renderInput.finalConcurrency ?? 1,
    decode_threads: renderInput.decodeThreads ?? 0,
  };
  log.info(`studio.${kind} done`, {
    width: finalWidth,
    height: finalHeight,
    duration_s: finalDuration,
    size_bytes: videoStats.size,
    thumbnails: thumbnailManifestEntries.length,
    ...stats,
  });

  return {
    manifest: RENDER_MANIFEST_PATH,
    summary: {
      width: finalWidth,
      height: finalHeight,
      duration_s: finalDuration,
      size_bytes: videoStats.size,
      watermarked: anyWatermarked,
      ...stats,
    },
  };
}

// ---- Tiện ích ----

async function fileExists(p: string): Promise<boolean> {
  const { existsSync } = await import('node:fs');
  return existsSync(p);
}

// ---- Exported handlers ----

export function makeStudioRenderPreviewHandler(
  extra: RenderWorkerExtra = {},
): (ctx: JobContext) => Promise<JobResult> {
  return (ctx) => handleStudioRender(ctx, 'render_preview', extra);
}

export function makeStudioRenderFinalHandler(
  extra: RenderWorkerExtra = {},
): (ctx: JobContext) => Promise<JobResult> {
  return (ctx) => handleStudioRender(ctx, 'render_final', extra);
}

export const handleStudioRenderPreview = makeStudioRenderPreviewHandler();
export const handleStudioRenderFinal = makeStudioRenderFinalHandler();
