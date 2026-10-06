/**
 * Handler studio.export_premiere:
 * Download composition → download media → probe → render overlay PNGs →
 * build project.xml + README + premiere.json → zip → upload.
 *
 * Progress: 5–70 download, 70–75 overlays, 75–90 zip, 90–100 upload.
 */
import { mkdirSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { join, basename, relative, extname } from 'node:path';
import {
  StudioExportPremierePayloadSchema,
  PremiereManifestSchema,
  PREMIERE_MANIFEST_SCHEMA,
  PREMIERE_MANIFEST_PATH,
} from '@ag-farm/protocol';
import type { JobResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import { studioOverlayAss, CompositionSchema } from '@ag-studio/render';
import { probeMedia, runFfmpeg, resolveFfmpeg, resolveFfprobe } from './ffmpeg-utils.js';
import { ArialMissingError, prepareArialDir } from './fonts.js';
import type { RenderWorkerExtra } from './config.js';
import {
  premiereXml,
  PREMIERE_README_VI,
  secondsToFrames,
  type PremiereFile,
  type PremiereSequence,
} from './premiere-xml.js';

// ---- Zip with yazl ----

import yazl from 'yazl';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

/** Stream a yazl ZipFile to disk. */
function writeZipToFile(zipFile: yazl.ZipFile, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    zipFile.outputStream.pipe(createWriteStream(destPath))
      .on('finish', resolve)
      .on('error', reject);
    zipFile.outputStream.on('error', reject);
  });
}

// ---- Slug helpers ----

/**
 * Turn a source id or a video name into a filesystem-safe ASCII slug (max 40 chars): Vietnamese marks are
 * dropped (`Chợ nổi Cái Răng` → `Cho_noi_Cai_Rang`) so Premiere on any OS finds the file the XML names.
 */
export function slugify(s: string): string {
  return s
    .replace(/^[a-z]+:/, '')       // strip input-kind prefix
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'clip';
}

// ---- Handler ----

async function handleExportPremiere(
  ctx: JobContext,
  extra: RenderWorkerExtra = {},
): Promise<JobResult> {
  // 1. Validate payload
  const payloadResult = StudioExportPremierePayloadSchema.safeParse(ctx.payload);
  if (!payloadResult.success) {
    throw new NonRetryableError(
      'invalid_payload',
      `Invalid export_premiere payload: ${payloadResult.error.message}`,
    );
  }
  const payload = payloadResult.data;

  const log = ctx.log.child({
    handler: 'studio.export_premiere',
    production_id: payload.production_id,
    episode_id: payload.episode_id,
  });
  log.info('Starting studio.export_premiere', { media: payload.media, name: payload.name });

  const workDir = ctx.workDir;
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const ffmpegTimeoutMs = (extra.ffmpeg_timeout_s ?? 3600) * 1000;

  ctx.progress(5, 'download_composition');

  // 2. Download composition JSON
  const compositionPath = join(workDir, 'composition.json');
  await ctx.download(payload.composition, compositionPath);

  if (ctx.signal.aborted) throw new Error('Job aborted');

  const { readFileSync } = await import('node:fs');
  const rawJson = JSON.parse(readFileSync(compositionPath, 'utf8'));
  const compositionResult = CompositionSchema.safeParse(rawJson);
  if (!compositionResult.success) {
    throw new NonRetryableError(
      'invalid_composition',
      `Composition JSON is invalid: ${compositionResult.error.message}`,
    );
  }
  const composition = compositionResult.data;

  const fps = (composition.output.fps === 30 ? 30 : 25) as 25 | 30;
  const canvasW = composition.output.width;
  const canvasH = composition.output.height;

  // 3. Download media files
  const mediaDir = join(workDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  // Distinct asset inputs (segments by order)
  const downloadedMedia = new Map<string, string>(); // inputName → local path
  const warnings: string[] = [];

  // We need to track source_kind and watermarked per input for the manifest
  const sourceMetas = new Map<string, { source_kind: 'original' | 'proxy' | 'preview'; watermarked: boolean }>();

  // Collect segments (in order) and their asset input names
  const segments = [...composition.segments].sort((a, b) => a.order - b.order);
  const assetInputs: string[] = [];
  for (const seg of segments) {
    const name = seg.source_path;
    if (name.startsWith('asset:') && !assetInputs.includes(name)) {
      assetInputs.push(name);
    }
  }

  // `media/NN-<tên video>.mp4`: the name Studio sent for the video, its id when there is none.
  const mediaFileNames = new Map<string, string>();
  assetInputs.forEach((inputName, i) => {
    const slug = slugify(payload.media_names[inputName] ?? inputName.replace(/^asset:/, ''));
    mediaFileNames.set(inputName, `${String(i + 1).padStart(2, '0')}-${slug}.mp4`);
  });

  // Sign all asset inputs to get metadata (source_kind, watermarked, cache_key)
  const totalAssets = assetInputs.length + (composition.music ? 1 : 0);
  let downloadedCount = 0;

  for (let i = 0; i < assetInputs.length; i++) {
    const inputName = assetInputs[i]!;
    if (ctx.signal.aborted) throw new Error('Job aborted');

    const localPath = join(mediaDir, mediaFileNames.get(inputName)!);

    await ctx.download(inputName, localPath);

    // Try to get source metadata via sign
    try {
      const { sign } = ctx;
      const [signResult] = await sign.sign([{ op: 'get' as const, input: inputName }]);
      if (signResult && 'source' in signResult && signResult.source) {
        sourceMetas.set(inputName, {
          source_kind: (signResult.source as { source_kind: string }).source_kind as 'original' | 'proxy' | 'preview',
          watermarked: (signResult.source as { watermarked: boolean }).watermarked,
        });
      } else {
        sourceMetas.set(inputName, { source_kind: 'proxy', watermarked: false });
      }
    } catch {
      sourceMetas.set(inputName, { source_kind: 'proxy', watermarked: false });
    }

    downloadedMedia.set(inputName, localPath);
    downloadedCount++;
    ctx.progress(5 + Math.round(60 * (downloadedCount / Math.max(1, totalAssets))), 'download_assets');
  }

  // Download music if present
  let musicLocalPath: string | null = null;
  if (composition.music) {
    if (ctx.signal.aborted) throw new Error('Job aborted');
    const musicInputName = composition.music.path;
    const musicExt = extname(musicInputName) || '.mp3';
    musicLocalPath = join(mediaDir, `music${musicExt}`);
    await ctx.download(musicInputName, musicLocalPath);
    downloadedCount++;
    ctx.progress(5 + Math.round(60 * (downloadedCount / Math.max(1, totalAssets))), 'download_music');
  }

  ctx.progress(65, 'probe_media');

  // 4. Probe all media files
  type ProbeInfo = { durationFrames: number; width: number; height: number; hasAudio: boolean };
  const probed = new Map<string, ProbeInfo>();

  for (const [inputName, localPath] of downloadedMedia) {
    if (ctx.signal.aborted) throw new Error('Job aborted');
    try {
      const info = await probeMedia(localPath, ffprobe);
      probed.set(inputName, {
        durationFrames: Math.max(1, Math.round(info.duration_seconds * fps)),
        width: info.width,
        height: info.height,
        hasAudio: info.has_audio,
      });
    } catch (e) {
      warnings.push(`Failed to probe ${inputName}: ${String(e)}`);
      probed.set(inputName, { durationFrames: fps * 10, width: canvasW, height: canvasH, hasAudio: false });
    }
  }

  let musicProbed: ProbeInfo | null = null;
  if (musicLocalPath) {
    try {
      const info = await probeMedia(musicLocalPath, ffprobe);
      musicProbed = {
        durationFrames: Math.max(1, Math.round(info.duration_seconds * fps)),
        width: 0,
        height: 0,
        hasAudio: info.has_audio,
      };
    } catch (e) {
      warnings.push(`Failed to probe music: ${String(e)}`);
      musicProbed = { durationFrames: fps * 60, width: 0, height: 0, hasAudio: true };
    }
  }

  ctx.progress(68, 'build_sequence');

  // 5. Build Premiere sequence (V1 clips in order)
  const clips: PremiereSequence['clips'] = [];
  let timelineCursor = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const inputName = seg.source_path;
    if (!inputName.startsWith('asset:')) continue; // skip non-asset segments

    const localPath = downloadedMedia.get(inputName);
    if (!localPath) continue;

    const info = probed.get(inputName) ?? { durationFrames: fps * 5, width: canvasW, height: canvasH, hasAudio: false };
    // Clip duration is the used portion (seg.out - seg.in)
    const clipDurationFrames = Math.max(1, Math.round((seg.out - seg.in) * fps));
    const relPath = `media/${basename(localPath)}`;

    const premiereFile: PremiereFile = {
      key: seg.source_id ?? inputName,
      name: basename(localPath),
      path: relPath,
      durationFrames: clipDurationFrames,
      width: info.width || canvasW,
      height: info.height || canvasH,
      hasAudio: info.hasAudio,
    };

    clips.push({ file: premiereFile, startFrame: timelineCursor });
    timelineCursor += clipDurationFrames;
  }

  ctx.progress(70, 'render_overlays');

  // 6. Render one transparent PNG per text event
  const overlaysDir = join(workDir, 'overlays');
  mkdirSync(overlaysDir, { recursive: true });

  const overlays: PremiereSequence['overlays'] = [];

  const textEvents = composition.text_events ?? [];
  let fontsDir: string | null = null;

  if (textEvents.length > 0) {
    // Prepare Arial dir once
    try {
      fontsDir = prepareArialDir(join(workDir, 'fonts'), extra.fonts_dir);
    } catch (e) {
      if (e instanceof ArialMissingError) {
        throw new NonRetryableError('fonts_missing', (e as ArialMissingError).message);
      }
      throw e;
    }

    for (let i = 0; i < textEvents.length; i++) {
      if (ctx.signal.aborted) throw new Error('Job aborted');
      const evt = textEvents[i]!;
      const n = String(i + 1).padStart(3, '0');
      const pngName = `T${n}.png`;
      const pngPath = join(overlaysDir, pngName);
      const assPath = join(workDir, `overlay-T${n}.ass`);

      // Build a mini-composition for this single text event (reset timing to t=0 so it always shows)
      const miniComp: unknown = {
        output: { width: canvasW, height: canvasH, fps, codec: 'h264' },
        captions: { mode: 'none', cues: [] },
        text_events: [{ ...evt, start: 0, end: 9999 }],
      };
      const ass = studioOverlayAss(miniComp as import('@ag-studio/render').Composition);
      if (!ass) {
        warnings.push(`No ASS output for text event ${evt.id}`);
        continue;
      }

      writeFileSync(assPath, ass, 'utf8');

      // Use relative paths for assPath and fontsDir (Windows colon issue in filtergraph)
      const assRel = basename(assPath);
      const fontsDirRel = fontsDir ? relative(workDir, fontsDir) : null;

      const lavfiInput = `color=c=black@0:s=${canvasW}x${canvasH},format=rgba`;
      const assFilter = fontsDirRel
        ? `ass=${assRel}:fontsdir=${fontsDirRel}`
        : `ass=${assRel}`;

      const ffmpegArgs = [
        '-f', 'lavfi', '-i', lavfiInput,
        '-vf', assFilter,
        '-frames:v', '1',
        '-y',
        pngPath,
      ];

      try {
        await runFfmpeg(ffmpeg, ffmpegArgs, { timeoutMs: ffmpegTimeoutMs, signal: ctx.signal, cwd: workDir });
      } catch (e) {
        warnings.push(`Overlay PNG for ${evt.id} failed: ${String(e)}`);
        continue;
      }

      overlays.push({
        name: pngName,
        path: `overlays/${pngName}`,
        startFrame: secondsToFrames(evt.start, fps),
        endFrame: secondsToFrames(evt.end, fps),
      });

      ctx.progress(70 + Math.round(5 * ((i + 1) / textEvents.length)), 'render_overlays');
    }
  }

  ctx.progress(75, 'build_xml');

  // 7. Build Premiere XML
  const totalFrames = clips.reduce((end, c) => Math.max(end, c.startFrame + c.file.durationFrames), 0);

  // Music file entry
  let musicEntry: PremiereSequence['music'] = null;
  if (composition.music && musicLocalPath && musicProbed) {
    const musicExt = extname(musicLocalPath) || '.mp3';
    const musicRelPath = `media/music${musicExt}`;
    musicEntry = {
      file: {
        key: `music-${composition.music.track_id ?? 'track'}`,
        name: basename(musicLocalPath),
        path: musicRelPath,
        durationFrames: musicProbed.durationFrames,
        width: 0,
        height: 0,
        hasAudio: true,
      },
      gainDb: 0, // gain applied separately by Premiere user; default brand gain is -18dB
    };
  }

  // Markers (chapters)
  const markers = payload.markers.map((mk) => ({
    frame: secondsToFrames(mk.t_s, fps),
    name: mk.title,
  }));

  // Studio writes the timeline's `source_audio.muted` as `has_audio: false` on every segment
  // (`timelineToComposition`), and the render then drops their sound: A1 follows.
  const assetSegments = segments.filter((s) => s.source_path.startsWith('asset:'));
  const sourceAudioMuted = assetSegments.length > 0 && assetSegments.every((s) => !s.has_audio);

  const seq: PremiereSequence = {
    name: payload.name,
    fps,
    width: canvasW,
    height: canvasH,
    clips,
    overlays,
    music: musicEntry,
    sourceAudioMuted,
    markers,
  };

  const xmlContent = premiereXml(seq);
  const xmlPath = join(workDir, 'project.xml');
  writeFileSync(xmlPath, xmlContent, 'utf8');

  // README
  const readmePath = join(workDir, 'README.txt');
  writeFileSync(readmePath, PREMIERE_README_VI, 'utf8');

  ctx.progress(76, 'build_zip');

  // 8. Zip everything with yazl (zip64; store media, deflate text)
  const zipPath = join(workDir, 'export.zip');
  const zipFile = new yazl.ZipFile();

  // Add media files
  const manifestFiles: Array<{ path: string; size_bytes: number; source_kind: 'original' | 'proxy' | 'preview'; watermarked: boolean }> = [];

  for (const [inputName, localPath] of downloadedMedia) {
    const zipEntryName = `media/${basename(localPath)}`;
    const stat = statSync(localPath);
    zipFile.addFile(localPath, zipEntryName, { compress: false });
    const meta = sourceMetas.get(inputName) ?? { source_kind: 'proxy', watermarked: false };
    manifestFiles.push({
      path: zipEntryName,
      size_bytes: stat.size,
      source_kind: meta.source_kind,
      watermarked: meta.watermarked,
    });
    ctx.progress(76 + Math.round(5 * (downloadedCount > 0 ? manifestFiles.length / downloadedCount : 1)), 'zip_media');
  }

  if (musicLocalPath) {
    const musicExt = extname(musicLocalPath) || '.mp3';
    const musicZipEntry = `media/music${musicExt}`;
    const stat = statSync(musicLocalPath);
    zipFile.addFile(musicLocalPath, musicZipEntry, { compress: false });
    manifestFiles.push({
      path: musicZipEntry,
      size_bytes: stat.size,
      source_kind: 'original',
      watermarked: false,
    });
  }

  // Add overlay PNGs (store — PNG is already compressed)
  for (const ov of overlays) {
    const pngPath = join(workDir, 'overlays', basename(ov.path));
    if (statSync(pngPath).size > 0) {
      zipFile.addFile(pngPath, ov.path, { compress: false });
    }
  }

  // Add text files (deflate)
  zipFile.addFile(xmlPath, 'project.xml', { compress: true });
  zipFile.addFile(readmePath, 'README.txt', { compress: true });

  // End the zip (signals no more entries)
  zipFile.end({ forceZip64Format: true });

  await writeZipToFile(zipFile, zipPath);

  if (ctx.signal.aborted) throw new Error('Job aborted');

  ctx.progress(90, 'upload_zip');

  // 9. Upload zip
  const zipStat = statSync(zipPath);
  await ctx.upload(zipPath, payload.output, 'application/zip');

  ctx.progress(98, 'upload_manifest');

  // 10. Build and upload premiere.json
  const manifest = PremiereManifestSchema.parse({
    schema: PREMIERE_MANIFEST_SCHEMA,
    output: payload.output,
    size_bytes: zipStat.size,
    media: payload.media,
    files: manifestFiles,
    warnings,
  });

  await ctx.uploadJson(PREMIERE_MANIFEST_PATH, manifest);

  log.info('studio.export_premiere done', {
    zip_size: zipStat.size,
    clips: clips.length,
    overlays: overlays.length,
    markers: markers.length,
  });

  ctx.progress(100, 'done');

  return {
    manifest: PREMIERE_MANIFEST_PATH,
    summary: {
      zip_size_bytes: zipStat.size,
      clips: clips.length,
      overlays: overlays.length,
      media: payload.media,
    },
  };
}

// ---- Exported factory ----

export function makeStudioExportPremiereHandler(
  extra: RenderWorkerExtra = {},
): (ctx: JobContext) => Promise<JobResult> {
  return (ctx) => handleExportPremiere(ctx, extra);
}
