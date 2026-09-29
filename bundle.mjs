/**
 * Bundle ag-render-worker thành một file dist/bundle.cjs bằng esbuild.
 * Dùng cho triển khai đơn file (NSSM/WinSW, systemd).
 */
import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const _require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// Các package native cần exclude để esbuild không cố bundle
const nativeModules = ['ffmpeg-static', 'ffprobe-static', 'sharp'];

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  outfile: 'dist/bundle.cjs',
  format: 'cjs',
  external: [
    ...nativeModules,
    // Link deps: resolve từ filesystem khi chạy
    '@ag-farm/protocol',
    '@ag-farm/worker-sdk',
    '@ag-studio/render',
  ],
  define: {
    'process.env.npm_package_version': JSON.stringify(pkg.version),
  },
  logLevel: 'info',
});

console.log('Bundle xong: dist/bundle.cjs');
