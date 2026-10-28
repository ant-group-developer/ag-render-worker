/**
 * Đóng gói ag-render-worker thành một thư mục cài đặt tự chạy được trên máy worker (không cần clone
 * ag-farm, ag-studio bên cạnh):
 *
 *   release/ag-render-worker-<version>/
 *     dist/worker.mjs        mọi JS, gồm cả @ag-farm/* và @ag-studio/render (link: lúc dev)
 *     package.json           chỉ còn ffmpeg-static, ffprobe-static (binary, cài lúc `npm install`)
 *     engines/python/        tts.py (OmniVoice) + voice_clean.py, transcribe.py (WhisperX), beats.py (librosa), engine_io.py, requirements.txt
 *     fonts/                 font OFL cho chữ trên video (fonts.json; tải bằng scripts/fetch-fonts.mjs, kiểm sha256)
 *     deploy/*               setup-render.ps1 (install.ps1 chạy: Python, venv, torch, yt-dlp, model), mẫu config
 *   release/ag-render-worker-<version>.zip
 *
 * Chạy trên máy dev đã build được repo (ag-farm, ag-studio nằm cạnh): node scripts/release.mjs
 * Phát hành lên farm (máy worker tự cập nhật): khoá phát hành của hub trong biến môi trường FARM_RELEASE_KEY (không
 * truyền khoá trên dòng lệnh), rồi
 *   node scripts/release.mjs --publish --upload https://api-farm.ant-group.net [--key-env TÊN_BIẾN]
 * Hub từ chối bản không mới hơn bản đang phát hành: tăng `version` trong package.json trước.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `ag-render-worker-${pkg.version}`;
const out = join(root, 'release', name);

// Binary/native: không bundle được, cài bằng npm trên máy đích.
const NATIVE = ['ffmpeg-static', 'ffprobe-static'];

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(out, 'dist', 'worker.mjs'),
  external: NATIVE,
  // Thư viện CommonJS trong bundle ESM vẫn gọi require().
  banner: { js: "import { createRequire as __agCreateRequire } from 'node:module'; const require = __agCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});

writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: 'module',
      description: pkg.description,
      scripts: { start: 'node dist/worker.mjs --config config.yaml' },
      dependencies: Object.fromEntries(NATIVE.map((d) => [d, pkg.dependencies[d]])),
    },
    null,
    2,
  ) + '\n',
);

// Engine Python: chép cả thư mục (không lấy __pycache__, *.pyc), để engine mới không bị bỏ sót như
// transcribe.py ở 0.6.0–0.8.0 (danh sách file cố định chỉ có tts.py).
cpSync(join(root, 'engines', 'python'), join(out, 'engines', 'python'), {
  recursive: true,
  filter: (src) => !/(^|[\\/])__pycache__([\\/]|$)|\.pyc$/.test(src),
});
// Script mà handler gọi (python-runner.ts, transcribe-handler.ts): thiếu là máy worker báo lỗi Errno 2.
for (const f of ['tts.py', 'voice_clean.py', 'transcribe.py', 'beats.py', 'engine_io.py', 'requirements.txt', 'setup_check.py']) {
  if (!existsSync(join(out, 'engines', 'python', f))) throw new Error(`release: thieu engines/python/${f}`);
}
// Font OFL (Studio TEXT_FONTS): tải file còn thiếu, kiểm sha256 theo fonts.json, chép cả thư mục (máy thiếu font thì tự
// kiểm lúc khởi động báo lỗi và hạ mức render).
const { fetchFonts } = await import(pathToFileURL(join(root, 'scripts', 'fetch-fonts.mjs')).href);
const fonts = await fetchFonts({ log: () => {} });
mkdirSync(join(out, 'fonts'), { recursive: true });
cpSync(join(root, 'fonts', 'fonts.json'), join(out, 'fonts', 'fonts.json'));
for (const f of fonts.fonts) {
  for (const name of [f.license_file, ...f.files.map((x) => x.file)]) cpSync(join(root, 'fonts', name), join(out, 'fonts', name));
}
cpSync(join(root, 'deploy'), join(out, 'deploy'), { recursive: true });
// install.ps1 của farm chạy file này lúc cài và lúc cập nhật (Python, venv, torch, yt-dlp, model)
if (!existsSync(join(out, 'deploy', 'setup-render.ps1'))) throw new Error('release: thieu deploy/setup-render.ps1');

// node_modules, runtime/node.exe, run.cmd, zip và phát hành lên farm (--publish --upload <hub>, hoặc --publish <dir>):
// phần chung với worker kia, nằm ở ag-farm/tools/worker-installer.
const installer = join(root, '..', 'ag-farm', 'tools', 'worker-installer', 'package-release.mjs');
const { finishRelease, publishOptionsFromArgv } = await import(pathToFileURL(installer).href);
await finishRelease({
  repoRoot: root,
  releaseRoot: join(root, 'release'),
  name,
  packageName: 'ag-render-worker', // = RELEASE_PACKAGE (src/config.ts): tên worker tự cập nhật theo
  version: pkg.version,
  ...publishOptionsFromArgv(),
});
