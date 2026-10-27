/**
 * Điểm vào chính cho ag-render-worker.
 * Dùng: ag-render-worker --config <đường dẫn YAML>
 */
import { runWorker, loadConfig } from '@ag-farm/worker-sdk';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RELEASE_PACKAGE, capabilitiesOptionsFor, getExtra } from './config.js';
import { makeStudioTtsHandler } from './tts-handler.js';
import { makeStudioRenderPreviewHandler, makeStudioRenderFinalHandler } from './render-handler.js';
import { makeStudioExportPremiereHandler } from './premiere-handler.js';
import { makeStudioTranscribeHandler } from './transcribe-handler.js';
import { makeStudioReferenceFetchHandler } from './reference-handler.js';
import { makeStudioBeatsHandler } from './beats-handler.js';
import { selfCheck } from './self-check.js';

const _require = createRequire(import.meta.url);

// ---- Parse args ----

function getConfigPath(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--config');
  if (idx === -1 || idx + 1 >= args.length) {
    console.error('Dung: ag-render-worker --config <duong dan file YAML>');
    process.exit(1);
  }
  return args[idx + 1]!;
}

// ---- Main ----

async function main(): Promise<void> {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);
  const extra = getExtra(config.extra);
  // Mezzanine dùng chung giữa các job, cạnh cache tải về của SDK (SDK tự dọn thư mục của nó theo max_gb).
  extra.mezz_cache_dir ??= `${config.cache.dir.replace(/[\\/]+$/, '')}-mezz`;

  let version = '0.0.0';
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = _require(join(__dirname, '..', 'package.json')) as { version?: string };
    version = pkg.version ?? '0.0.0';
  } catch {
    // ignore
  }

  console.log(`ag-render-worker v${version} khoi dong voi config: ${configPath}`);

  // Tự kiểm: thiếu file thì vẫn chạy, nhưng không khai việc sẽ hỏng (self-check.ts)
  const check = selfCheck({ ...(extra.fonts_dir ? { fontsDir: extra.fonts_dir } : {}), ...(extra.bundled_fonts_dir ? { bundledDir: extra.bundled_fonts_dir } : {}) });
  for (const problem of check.problems) console.error(`[self-check] LOI: ${problem}`);
  if (check.problems.length === 0) console.log(`[self-check] du engine Python, font; muc render ${check.studioRender}`);

  // Tạo handlers với extra config
  const ttHandler = makeStudioTtsHandler({ extra });
  const previewHandler = makeStudioRenderPreviewHandler(extra);
  const finalHandler = makeStudioRenderFinalHandler(extra);
  const exportPremiereHandler = makeStudioExportPremiereHandler(extra);
  const transcribeHandler = makeStudioTranscribeHandler({ extra });
  const referenceFetchHandler = makeStudioReferenceFetchHandler({ extra });
  const beatsHandler = makeStudioBeatsHandler({ extra });

  await runWorker({
    config,
    version,
    // studio.tts, studio.transcribe and studio.beats need python: true, i.e. extra.python_bin imports torch
    capabilitiesOptions: capabilitiesOptionsFor(extra, undefined, check),
    // Máy cài bằng install.ps1 (config có updater_task): tự lên bản mới khi hub phát hành.
    selfUpdate: { package: RELEASE_PACKAGE },
    // Một bản render một lúc trên mỗi máy (config `exclusive_kinds` ghi đè, `[]` = tắt): máy 4 slot CPU từng nhận cả 3
    // bản render của một đợt rồi chạy chung, trong khi máy khác ngồi không.
    exclusiveKinds: ['studio.render_preview', 'studio.render_final'],
    handlers: {
      'studio.tts': ttHandler,
      'studio.render_preview': previewHandler,
      'studio.render_final': finalHandler,
      'studio.export_premiere': exportPremiereHandler,
      'studio.transcribe': transcribeHandler,
      // only machines with yt-dlp (engines.ytdlp) report this kind
      'studio.reference_fetch': referenceFetchHandler,
      // librosa, in the same venv (a dependency of OmniVoice too)
      'studio.beats': beatsHandler,
    },
  });
}

main().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
