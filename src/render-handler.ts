/**
 * Handler studio.render_preview và studio.render_final:
 * Tải composition → thu thập input → cắt đoạn nguồn thành mezzanine cục bộ
 * → ghi đè path → gọi renderComposition → upload output + render.json.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import {
  StudioRenderPayloadSchema,
  RenderManifestSchema,
  RENDER_MANIFEST_SCHEMA,
  RENDER_MANIFEST_PATH,
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
  computeRangeCut,
} from './composition-utils.js';
import { probeMedia, cutSegmentToMezz, resolveFfmpeg, resolveFfprobe } from './ffmpeg-utils.js';
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

function makeMezzCache(cacheDir: string): import('@ag-studio/render').RenderDeps['cache'] {
  // MezzCache interface: { dir: string, max_bytes: number }
  return { dir: cacheDir, max_bytes: 20 * 1024 * 1024 * 1024 } as unknown as import('@ag-studio/render').RenderDeps['cache'];
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
  const handleSeconds = payload.handle_seconds;
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

  // Phân loại: segment inputs vs. các input khác
  const segmentInputs: string[] = [];
  const otherInputs: string[] = [];
  for (const name of inputNames) {
    if (name.startsWith('segment:')) {
      segmentInputs.push(name);
    } else {
      otherInputs.push(name);
    }
  }

  const inputToLocal = new Map<string, string>();
  const sourceMetas = new Map<string, {
    source_kind: 'original' | 'proxy' | 'preview';
    watermarked: boolean;
  }>();

  ctx.progress(8, 'sign_segments');

  // 4. Sign và cắt đoạn nguồn.
  //
  // `resolve` của ag-go trả URL của CẢ file (gốc, proxy hoặc preview) kèm `start_ms`/`end_ms` cho biết đoạn nằm
  // ở đâu trong file. Vì vậy `seg.in`/`seg.out` là vị trí trong file, và phần dư hai đầu được phép vượt ra ngoài
  // đoạn (phần đó vẫn là hình của file): chỉ kẹp ở 0, cuối file để ffmpeg tự dừng. Mỗi clip của composition có
  // mezzanine riêng, vì hai clip có thể dùng cùng một `segment:<id>` ở hai khoảng khác nhau.
  const segmentLocal = new Map<number, string>();
  if (segmentInputs.length > 0) {
    const signOps = segmentInputs.map((name) => ({ op: 'get' as const, input: name }));
    const signResults: SignResult[] = await ctx.sign.sign(signOps);

    const urlByInput = new Map<string, string>();
    for (let i = 0; i < segmentInputs.length; i++) {
      const inputName = segmentInputs[i]!;
      const signResult = signResults[i];
      if (!signResult || signResult.op !== 'get') {
        throw new Error(`Unexpected sign result for ${inputName}`);
      }
      urlByInput.set(inputName, signResult.url);
      sourceMetas.set(inputName, {
        source_kind: signResult.source?.source_kind ?? 'preview',
        watermarked: signResult.source?.watermarked ?? true,
      });
    }

    const mezzsDir = join(workDir, 'mezzs');
    mkdirSync(mezzsDir, { recursive: true });

    const segmentClips = composition.segments
      .map((seg, index) => ({ seg, index }))
      .filter(({ seg }) => seg.source_path.startsWith('segment:'));
    for (let n = 0; n < segmentClips.length; n++) {
      const { seg, index } = segmentClips[n]!;
      const sourceUrl = urlByInput.get(seg.source_path);
      if (!sourceUrl) throw new Error(`No signed URL for ${seg.source_path}`);

      const rangeCut = computeRangeCut(seg.in, seg.out, handleSeconds, null);
      if (rangeCut.cutDuration <= 0) {
        throw new NonRetryableError('invalid_composition', `Segment ${index} (${seg.source_path}) has an empty range ${seg.in}–${seg.out}`);
      }
      const mezzPath = join(mezzsDir, `clip-${String(index).padStart(4, '0')}.mp4`);
      log.info('Cutting segment', {
        input: seg.source_path,
        order: seg.order,
        sourceStart: rangeCut.sourceStart,
        duration: rangeCut.cutDuration,
        quality: isPreview ? 'preview' : 'final',
      });

      await cutSegmentToMezz(sourceUrl, mezzPath, {
        startSeconds: rangeCut.sourceStart,
        durationSeconds: rangeCut.cutDuration,
        quality: isPreview ? 'preview' : 'final',
        timeoutMs: ffmpegTimeoutMs,
        signal: ctx.signal,
      });

      segmentLocal.set(index, mezzPath);
      // in/out now count from the start of this clip's own cut
      (seg as typeof seg & { in: number; out: number }).in = rangeCut.localIn;
      (seg as typeof seg & { in: number; out: number }).out = rangeCut.localOut;

      ctx.progress(
        8 + Math.round(40 * ((n + 1) / segmentClips.length)),
        'cut_segments',
      );
    }
  }

  ctx.progress(50, 'download_inputs');

  // 5. Download các input khác
  for (let i = 0; i < otherInputs.length; i++) {
    const name = otherInputs[i]!;
    // Bỏ qua brand.dir và fonts_dir vì là thư mục (không download trực tiếp)
    // Trong thực tế chúng cần xử lý phức tạp hơn - đây chỉ download file đơn
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
        // Một số input có thể không tồn tại (brand.dir, fonts_dir là thư mục)
        log.info('Could not download input, skipping', { name, error: String(e) });
      }
    }
    ctx.progress(50 + Math.round(10 * ((i + 1) / Math.max(1, otherInputs.length))), 'download_inputs');
  }

  ctx.progress(62, 'rewrite_composition');

  // 6. Ghi đè đường dẫn composition
  const localComposition = rewriteCompositionPaths(composition, inputToLocal);
  // Footage clips point at their own mezzanine (a name -> path map cannot tell two clips of one segment apart)
  // and get their own source id: renderComposition keys its mezzanine cache by source + in/out, and two cuts
  // of one segment of equal length have identical local in/out.
  localComposition.segments = localComposition.segments.map((seg, index) => {
    const local = segmentLocal.get(index);
    return local ? { ...seg, source_path: local, source_id: clipSourceId(seg.source_id, index) } : seg;
  });

  // 7. Chuẩn bị renderComposition
  const outDir = join(workDir, 'render_out');
  mkdirSync(outDir, { recursive: true });

  const mezzCacheDir = join(workDir, 'mezz_cache');
  mkdirSync(mezzCacheDir, { recursive: true });

  // sourceChecksums: dùng input name làm proxy cho source_id
  // Trong production, đây sẽ là sha256 thật của file nguồn
  const sourceChecksums = new Map<string, string>();
  for (const seg of localComposition.segments) {
    // Dùng source_path (đã được rewrite thành path cục bộ) làm checksum proxy
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
  };

  ctx.progress(65, 'render');
  log.info('Calling renderComposition', { canvas: `${payload.canvas.width}x${payload.canvas.height}` });

  const { report, episodePath } = await renderComposition(renderDeps, renderInput);

  ctx.progress(90, 'upload_video');

  // 8. Upload video output
  const outputRelPath = payload.output;
  const videoStats = statSync(episodePath);

  await ctx.upload(episodePath, outputRelPath, 'video/mp4', {
    // Dùng multipart cho file lớn (>64MB) - ctx.upload tự xử lý qua transfer.ts
  });

  ctx.progress(96, 'upload_manifest');

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

  // 10. Build render manifest
  const anyWatermarked = [...sourceMetas.values()].some((m) => m.watermarked);
  const sources = [...sourceMetas.entries()].map(([input, meta]) => ({
    input,
    source_kind: meta.source_kind,
    watermarked: meta.watermarked,
  }));

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
    warnings: report.warnings ?? [],
  });

  await ctx.uploadJson(RENDER_MANIFEST_PATH, renderManifest);

  log.info(`studio.${kind} done`, {
    width: finalWidth,
    height: finalHeight,
    duration_s: finalDuration,
    size_bytes: videoStats.size,
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
