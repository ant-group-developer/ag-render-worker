/**
 * Điểm vào chính cho ag-render-worker.
 * Dùng: ag-render-worker --config <đường dẫn YAML>
 */
import { runWorker, loadConfig } from '@ag-farm/worker-sdk';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getExtra } from './config.js';
import { makeStudioTtsHandler } from './tts-handler.js';
import { makeStudioRenderPreviewHandler, makeStudioRenderFinalHandler } from './render-handler.js';
import { makeStudioExportPremiereHandler } from './premiere-handler.js';

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

  // Tạo handlers với extra config
  const ttHandler = makeStudioTtsHandler({ extra });
  const previewHandler = makeStudioRenderPreviewHandler(extra);
  const finalHandler = makeStudioRenderFinalHandler(extra);
  const exportPremiereHandler = makeStudioExportPremiereHandler(extra);

  await runWorker({
    config,
    version,
    handlers: {
      'studio.tts': ttHandler,
      'studio.render_preview': previewHandler,
      'studio.render_final': finalHandler,
      'studio.export_premiere': exportPremiereHandler,
    },
  });
}

main().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
