/**
 * Handler studio.render_preview và studio.render_final:
 * Tải composition → thu thập input → cắt đoạn nguồn thành mezzanine cục bộ
 * → ghi đè path → gọi renderComposition → upload output + render.json.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
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
import { renderComposition, probeNvenc, CompositionSchema } from '@ag-studio/render';
import type { Composition } from './composition-utils.js';
import {
  collectCompositionInputs,
  rewriteCompositionPaths,
  computeRangeCut,
} from './composition-utils.js';
import { probeMedia, cutSegmentToMezz, resolveFfmpeg, resolveFfprobe } from './ffmpeg-utils.js';
import type { RenderWorkerExtra } from './config.js';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

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

  // 4. Sign và cắt đoạn nguồn
  // Sign tất cả segments trong một batch
  if (segmentInputs.length > 0) {
    const signOps = segmentInputs.map((name) => ({ op: 'get' as const, input: name }));
    const signResults: SignResult[] = await ctx.sign.sign(signOps);

    const mezzsDir = join(workDir, 'mezzs');
    mkdirSync(mezzsDir, { recursive: true });

    for (let i = 0; i < segmentInputs.length; i++) {
      const inputName = segmentInputs[i]!;
      const signResult = signResults[i];

      if (!signResult || signResult.op !== 'get') {
        throw new Error(`Unexpected sign result for ${inputName}`);
      }

      const sourceUrl = signResult.url;
      const sourceMeta = signResult.source;
      const sourceKind = sourceMeta?.source_kind ?? 'preview';
      const watermarked = sourceMeta?.watermarked ?? true;

      sourceMetas.set(inputName, { source_kind: sourceKind, watermarked });

      // Tìm segment dùng input này để lấy in/out
      const seg = composition.segments.find((s) => s.source_path === inputName);
      if (!seg) {
        // Input được khai nhưng không có segment dùng nó - bỏ qua
        continue;
      }

      // Thời lượng từ source metadata nếu có
      const sourceStartMs = sourceMeta?.start_ms ?? null;
      const sourceEndMs = sourceMeta?.end_ms ?? null;
      const sourceDurationSeconds =
        sourceStartMs !== null && sourceEndMs !== null
          ? (sourceEndMs - sourceStartMs) / 1000
          : null;

      // Tính khoảng cắt
      const rangeCut = computeRangeCut(
        seg.in,
        seg.out,
        handleSeconds,
        sourceDurationSeconds,
      );

      // Cắt thành file cục bộ
      const mezzPath = join(mezzsDir, `${inputName.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
      log.info('Cutting segment', {
        input: inputName,
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

      inputToLocal.set(inputName, mezzPath);

      // Rewrite segment in/out to be relative to the cut file
      (seg as typeof seg & { in: number; out: number }).in = rangeCut.localIn;
      (seg as typeof seg & { in: number; out: number }).out = rangeCut.localOut;

      ctx.progress(
        8 + Math.round(40 * ((i + 1) / segmentInputs.length)),
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

  const assPath: string | null = null; // ASS không được tạo ở đây; composition.captions đã có cues

  const renderInput: RenderInput = {
    composition: localComposition as unknown as import('@ag-studio/render').RenderInput['composition'],
    assPath,
    outDir,
    encoderCfg: 'cpu',  // không có NVIDIA GPU
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
