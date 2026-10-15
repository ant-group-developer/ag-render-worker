/**
 * Tự kiểm lúc khởi động: thiếu engine Python thì không khai Python, thiếu font thì hạ mức render, thiếu Arial thì báo.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RENDER_FEATURE_LEVEL, RENDER_FONT_LEVEL } from '@ag-studio/render';
import { selfCheck } from '../self-check.js';
import { capabilitiesOptionsFor } from '../config.js';

function machine(o: { engines: string[]; fonts: boolean; arial: boolean }) {
  const dir = join(tmpdir(), `self-check-${randomUUID()}`);
  const engines = join(dir, 'engines');
  const bundled = join(dir, 'fonts');
  const arial = join(dir, 'arial');
  for (const d of [engines, bundled, arial]) mkdirSync(d, { recursive: true });
  for (const f of o.engines) writeFileSync(join(engines, f), '# engine');
  writeFileSync(join(bundled, 'fonts.json'), JSON.stringify({ fonts: [{ family: 'Noto Sans JP', license: 'OFL-1.1', license_file: 'x.txt', files: [{ file: 'jp.ttf', url: 'x', sha256: null }] }] }));
  if (o.fonts) writeFileSync(join(bundled, 'jp.ttf'), 'j');
  if (o.arial) writeFileSync(join(arial, 'arial.ttf'), 'a');
  return selfCheck({ enginesDir: engines, bundledDir: bundled, fontsDir: arial });
}

describe('self-check at startup', () => {
  test('a complete machine has no problem and reports this build\'s render level', () => {
    const check = machine({ engines: ['tts.py', 'transcribe.py', 'beats.py', 'engine_io.py'], fonts: true, arial: true });
    expect(check).toMatchObject({ problems: [], python: true, studioRender: RENDER_FEATURE_LEVEL, missingEngines: [], missingFonts: [] });
    expect(capabilitiesOptionsFor({}, () => false, check)).toMatchObject({ detectPythonTorch: true, studioRender: RENDER_FEATURE_LEVEL });
  });

  test('a missing python engine: no python jobs; missing fonts: the render level below fonts; no Arial: said', () => {
    const check = machine({ engines: ['tts.py', 'beats.py', 'engine_io.py'], fonts: false, arial: false });
    expect(check.missingEngines).toEqual(['transcribe.py']);
    expect(check.missingFonts).toEqual(['Noto Sans JP']);
    expect(check.python).toBe(false);
    expect(check.studioRender).toBe(RENDER_FONT_LEVEL - 1);
    expect(check.problems).toHaveLength(3);
    expect(check.problems[0]).toContain('transcribe.py');
    expect(capabilitiesOptionsFor({ python_bin: 'python' }, () => false, check)).toMatchObject({ detectPythonTorch: false, studioRender: RENDER_FONT_LEVEL - 1 });
  });

  test('this repo ships every python engine', () => {
    expect(selfCheck().missingEngines).toEqual([]);
  });
});
