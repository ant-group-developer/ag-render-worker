/**
 * Font cho chữ trên video: Arial của máy cộng font OFL đóng kèm (fonts/fonts.json), chỉ chép font composition cần.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FontMissingError, ArialMissingError, bundledFontsDir, missingBundledFonts, prepareFontsDir, readBundledFonts } from '../fonts.js';

function setup(withJp = true) {
  const dir = join(tmpdir(), `fonts-${randomUUID()}`);
  const arial = join(dir, 'arial');
  const bundled = join(dir, 'bundled');
  mkdirSync(arial, { recursive: true });
  mkdirSync(bundled, { recursive: true });
  writeFileSync(join(arial, 'arial.ttf'), 'A');
  writeFileSync(join(arial, 'arialbd.ttf'), 'B');
  const fonts = [
    { family: 'Be Vietnam Pro', license: 'OFL-1.1', license_file: 'BVP-OFL.txt', files: [{ file: 'BVP-Regular.ttf', url: 'x', sha256: null }, { file: 'BVP-Bold.ttf', url: 'x', sha256: null }] },
    { family: 'Noto Sans JP', license: 'OFL-1.1', license_file: 'JP-OFL.txt', files: [{ file: 'NotoSansJP-VF.ttf', url: 'x', sha256: null }] },
  ];
  writeFileSync(join(bundled, 'fonts.json'), JSON.stringify({ fonts }));
  writeFileSync(join(bundled, 'BVP-Regular.ttf'), 'r');
  writeFileSync(join(bundled, 'BVP-Bold.ttf'), 'b');
  if (withJp) writeFileSync(join(bundled, 'NotoSansJP-VF.ttf'), 'j');
  return { dir, arial, bundled };
}

describe('fonts for the texts on the video', () => {
  test('a job gets Arial and exactly the shipped fonts it asks for', () => {
    const s = setup();
    const dest = prepareFontsDir(join(s.dir, 'job'), { families: ['Be Vietnam Pro', 'Noto Sans JP'], fontsDir: s.arial, bundledDir: s.bundled });
    expect(readdirSync(dest).sort()).toEqual(['BVP-Bold.ttf', 'BVP-Regular.ttf', 'NotoSansJP-VF.ttf', 'arial.ttf', 'arialbd.ttf']);
    const arialOnly = prepareFontsDir(join(s.dir, 'job2'), { families: ['Arial'], fontsDir: s.arial, bundledDir: s.bundled });
    expect(readdirSync(arialOnly).sort()).toEqual(['arial.ttf', 'arialbd.ttf']);
  });

  test('a missing shipped font fails the job naming it; Arial is only required when asked for', () => {
    const s = setup(false);
    expect(missingBundledFonts(s.bundled)).toEqual(['Noto Sans JP']);
    expect(() => prepareFontsDir(join(s.dir, 'job'), { families: ['Arial', 'Noto Sans JP'], fontsDir: s.arial, bundledDir: s.bundled }))
      .toThrow(FontMissingError);
    const noArial = join(s.dir, 'none');
    mkdirSync(noArial);
    expect(() => prepareFontsDir(join(s.dir, 'job3'), { families: ['Arial'], fontsDir: noArial, bundledDir: s.bundled })).toThrow(ArialMissingError);
    expect(readdirSync(prepareFontsDir(join(s.dir, 'job4'), { families: ['Be Vietnam Pro'], fontsDir: noArial, bundledDir: s.bundled })).sort())
      .toEqual(['BVP-Bold.ttf', 'BVP-Regular.ttf']);
    expect(missingBundledFonts(join(s.dir, 'nowhere'))).toEqual(['fonts.json']);
  });

  test('the package lists every font Studio may name', async () => {
    const { TEXT_FONTS } = await import('@ag-studio/render');
    const families = readBundledFonts(bundledFontsDir()).map((f) => f.family);
    expect(new Set([...families, 'Arial'])).toEqual(new Set(TEXT_FONTS));
  });
});
