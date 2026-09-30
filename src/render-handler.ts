/**
 * Handler studio.render_preview và studio.render_final:
 * Tải composition → thu thập input → download asset inputs → probe/clamp →
 * gọi renderComposition → upload output → (render_final) render thumbnails → upload render.json.
 *
 * GĐ2: footage clips dùng `asset:<id>` (toàn bộ file gốc, không cắt). `segment:` không còn hỗ trợ.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, relative } from 'node:path';
import {
  StudioRenderPayloadSchema,
  RenderManifestSchema,
  RENDER_MANIFEST_SCHEMA,
  RENDER_MANIFEST_PATH,
  thumbnailOutputPath,
} from '@ag-farm/protocol';
import type { JobResult, SignResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import type { RenderDeps, RenderInput } from '@ag-studio/render';
import { renderComposition, probeNvenc, CompositionSchema, studioOverlayAss } from '@ag-studio/render';
import type { Composition } from './composition-utils.js';
import {
  collectCompositionInputs,
  rewriteCompositionPaths,
} from './composition-utils.js';
import { probeMedia, runFfmpeg, resolveFfmpeg, resolveFfprobe } from './ffmpeg-utils.js';
import type { RenderWorkerExtra } from './config.js';
import { ArialMissingError, prepareArialDir } from './fonts.js';
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

// ---- Cache mezzanine đơn giản (dựa trên file system) ----

function makeMezzCache(cacheDir: string): RenderDeps['cache'] {
  return { dir: cacheDir, maxBytes: 20 * 1024 * 1024 * 1024 };
}

// ---- Tạo ASS subtitle đơn giản cho thumbnail ----

/**
 * Tạo nội dung file .ass cho thumbnail: chữ trắng đậm, viền đen, căn giữa dưới.
 * Text dài sẽ được ASS tự ngắt dòng (WrapStyle: 1 = smart wrap).
 */
export function buildThumbnailAss(text: string, width: number, height: number): string {
  const fontSize = Math.round(Math.min(width, height) * 0.072);
  const outline = Math.max(3, Math.round(fontSize * 0.12));
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
    `Style: Thumb,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${marginH},${marginH},${marginV},1\n` +
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

  // 4. Sign (metadata only) và download asset inputs.
  //
  // Asset inputs là toàn bộ file video (Studio gửi in: 0, out: <duration từ analysis>).
  // Mỗi asset được download một lần. Signing được gộp để lấy metadata (source_kind, watermarked,
  // cache_key); download thực sự đi qua ctx.download (kế thừa caching + file:// compatibility của SDK).
  if (assetInputs.length > 0) {
    // Gộp sign để lấy metadata tất cả assets cùng lúc
    const signOps = assetInputs.map((name) => ({ op: 'get' as const, input: name }));
    const signResults: SignResult[] = await ctx.sign.sign(signOps);

    const assetsDir = join(workDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });

    // Download từng distinct asset (không trùng lặp)
    const downloadedByInput = new Map<string, string>();
    for (let i = 0; i < assetInputs.length; i++) {
      const inputName = assetInputs[i]!;
      const signResult = signResults[i];
      if (!signResult || signResult.op !== 'get') {
        throw new Error(`Unexpected sign result for ${inputName}`);
      }

      const cacheKey = signResult.cache_key;

      sourceMetas.set(inputName, {
        source_kind: signResult.source?.source_kind ?? 'preview',
        watermarked: signResult.source?.watermarked ?? true,
      });

      // Đường dẫn cục bộ: dùng safeId cho file (không cache-keyed qua SDK)
      const safeId = inputName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const localPath = join(assetsDir, `${safeId}.mp4`);

      if (!(await fileExists(localPath))) {
        // ctx.download handles cache lookup, file:// in tests, and HTTP in production
        await ctx.download(inputName, localPath, { useCacheKey: cacheKey });
      }

      downloadedByInput.set(inputName, localPath);
      inputToLocal.set(inputName, localPath);

      ctx.progress(
        8 + Math.round(37 * ((i + 1) / assetInputs.length)),
        'download_assets',
      );
    }

    // 4b. Probe mỗi file và clamp seg.out nếu cần
    const probedDuration = new Map<string, number>();
    for (const [inputName, localPath] of downloadedByInput) {
      try {
        const probe = await probeMedia(localPath, ffprobe);
        probedDuration.set(inputName, probe.duration_seconds);
      } catch (e) {
        log.warn('Failed to probe asset, skipping clamp', { input: inputName, error: String(e) });
      }
    }

    // Clamp seg.out cho từng clip dùng asset:
    const CLAMP_TOLERANCE_S = 0.5;
    for (const seg of composition.segments) {
      if (!seg.source_path.startsWith('asset:')) continue;
      const probedDur = probedDuration.get(seg.source_path);
      if (probedDur === undefined) continue;
      if (seg.out > probedDur) {
        if (seg.out - probedDur > CLAMP_TOLERANCE_S) {
          const warning = `Asset ${seg.source_path}: segment out=${seg.out.toFixed(3)}s exceeds probed duration ${probedDur.toFixed(3)}s by more than ${CLAMP_TOLERANCE_S}s; clamping.`;
          log.warn(warning);
          // Thêm vào warnings của composition (warnings array mutable sau khi parse)
          if (!composition.warnings) (composition as Composition).warnings = [];
          composition.warnings.push(warning);
        }
        (seg as typeof seg & { out: number }).out = Math.max(seg.in, probedDur);
      }
    }
  }

  ctx.progress(50, 'download_inputs');

  // 5. Download các input khác (stage:, library:)
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
    ctx.progress(50 + Math.round(10 * ((i + 1) / Math.max(1, otherInputs.length))), 'download_inputs');
  }

  ctx.progress(62, 'rewrite_composition');

  // 6. Ghi đè đường dẫn composition
  const localComposition = rewriteCompositionPaths(composition, inputToLocal);

  // 7. Chuẩn bị renderComposition
  const outDir = join(workDir, 'render_out');
  mkdirSync(outDir, { recursive: true });

  const mezzCacheDir = join(workDir, 'mezz_cache');
  mkdirSync(mezzCacheDir, { recursive: true });

  const sourceChecksums = new Map<string, string>();
  for (const seg of localComposition.segments) {
    sourceChecksums.set(seg.source_id, seg.source_path);
  }

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
    cache: makeMezzCache(mezzCacheDir),
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

  // Chữ (track T) và phụ đề: dựng overlay.ass từ composition, font Arial lấy từ máy này (xem fonts.ts).
  let assPath: string | null = null;
  let fontsDir: string | null = null;
  const ass = studioOverlayAss(localComposition as unknown as import('@ag-studio/render').Composition);
  if (ass !== null) {
    try {
      fontsDir = prepareArialDir(join(workDir, 'fonts'), extra.fonts_dir);
    } catch (e) {
      if (e instanceof ArialMissingError) throw new NonRetryableError('fonts_missing', e.message);
      throw e;
    }
    assPath = join(workDir, 'overlay.ass');
    writeFileSync(assPath, ass, 'utf8');
    log.info('Burning text and subtitles', { fonts_dir: fontsDir });
  }

  const renderInput: RenderInput = {
    composition: localComposition as unknown as import('@ag-studio/render').RenderInput['composition'],
    assPath,
    fontsDir,
    outDir,
    encoderCfg: extra.encoder ?? 'auto',
    timeoutSeconds: ffmpegTimeoutMs / 1000,
    sourceChecksums,
    signal: ctx.signal,
    onProgress: (percent, stage) => ctx.progress(65 + Math.round(percent * 0.24), `render_${stage}`),
  };

  ctx.progress(65, 'render');
  log.info('Calling renderComposition', { canvas: `${payload.canvas.width}x${payload.canvas.height}` });

  const { report, episodePath } = await renderComposition(renderDeps, renderInput);

  ctx.progress(90, 'upload_video');

  // 8. Upload video output
  const outputRelPath = payload.output;
  const videoStats = statSync(episodePath);

  await ctx.upload(episodePath, outputRelPath, 'video/mp4');

  // 9. Probe video kết quả để lấy dims/duration
  let finalWidth = payload.canvas.width;
  let finalHeight = payload.canvas.height;
  let finalDuration = 0;

  try {
    const probeResult = await probeMedia(episodePath, ffprobe);
    finalWidth = probeResult.width || finalWidth;
    finalHeight = probeResult.height || finalHeight;
    finalDuration = probeResult.duration_seconds;
  } catch {
    finalDuration = report.output.seconds;
  }

  // 10. Thumbnails (chỉ render_final, khi có thumbnail nào được yêu cầu)
  const thumbnailManifestEntries: Array<{
    output: string;
    t_s: number;
    width: number;
    height: number;
  }> = [];

  if (!isPreview && payload.thumbnails.length > 0) {
    ctx.progress(91, 'render_thumbnails');

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

      ctx.progress(91 + Math.round(4 * (n / payload.thumbnails.length)), 'render_thumbnails');
    }
  }

  ctx.progress(96, 'upload_manifest');

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
  });

  await ctx.uploadJson(RENDER_MANIFEST_PATH, renderManifest);

  log.info(`studio.${kind} done`, {
    width: finalWidth,
    height: finalHeight,
    duration_s: finalDuration,
    size_bytes: videoStats.size,
    thumbnails: thumbnailManifestEntries.length,
  });

  return {
    manifest: RENDER_MANIFEST_PATH,
    summary: {
      width: finalWidth,
      height: finalHeight,
      duration_s: finalDuration,
      size_bytes: videoStats.size,
      watermarked: anyWatermarked,
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
