/**
 * Tải các font OFL đóng kèm bản phát hành (fonts/fonts.json) về fonts/ và kiểm sha256.
 *
 *   node scripts/fetch-fonts.mjs          tải file còn thiếu; file có sha256 trong fonts.json phải khớp
 *   node scripts/fetch-fonts.mjs --pin    như trên, rồi ghi sha256 của file chưa có vào fonts.json (lần đầu, hoặc khi đổi bản font)
 *
 * release.mjs gọi script này trước khi đóng gói, nên bản phát hành không bao giờ thiếu font. File .ttf và giấy phép
 * không nằm trong git (.gitignore).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'fonts');
const manifestPath = join(dir, 'fonts.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch-fonts: ${url} trả ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A TrueType/OpenType file starts with 0x00010000, 'true', 'OTTO' or 'ttcf'. */
function looksLikeFont(buf) {
  const tag = buf.subarray(0, 4).toString('latin1');
  return buf.length > 1024 && (buf.readUInt32BE(0) === 0x00010000 || tag === 'true' || tag === 'OTTO' || tag === 'ttcf');
}

export async function fetchFonts({ pin = false, log = console.log } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let pinned = 0;
  for (const font of manifest.fonts) {
    const license = join(dir, font.license_file);
    if (!existsSync(license)) {
      writeFileSync(license, await download(font.license_url));
      log(`  ${font.license_file}`);
    }
    for (const f of font.files) {
      const path = join(dir, f.file);
      if (!existsSync(path)) {
        const buf = await download(f.url);
        if (!looksLikeFont(buf)) throw new Error(`fetch-fonts: ${f.url} không phải file font`);
        writeFileSync(`${path}.part`, buf);
        renameSync(`${path}.part`, path);
        log(`  ${f.file} (${Math.round(buf.length / 1024)} KB)`);
      }
      const got = sha256(readFileSync(path));
      if (f.sha256 && f.sha256 !== got) throw new Error(`fetch-fonts: ${f.file} có sha256 ${got}, fonts.json ghi ${f.sha256} (xoá file rồi tải lại, hoặc --pin nếu cố ý đổi bản)`);
      if (!f.sha256 && pin) { f.sha256 = got; pinned++; }
      if (!f.sha256 && !pin) throw new Error(`fetch-fonts: ${f.file} chưa ghi sha256 trong fonts.json (chạy --pin một lần rồi commit fonts.json)`);
    }
  }
  if (pinned > 0) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  fetchFonts({ pin: process.argv.includes('--pin') })
    .then((m) => console.log(`fonts: ${m.fonts.map((f) => f.family).join(', ')}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
