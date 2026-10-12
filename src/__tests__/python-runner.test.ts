/**
 * Test: runner Python bị huỷ thì tiến trình con bị kill ngay, không chạy tới hết timeout.
 * Dùng `node` thay cho python: node chạy được file tên `tts.py` như một script JS.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createEngineRunner, createPythonRunner, pythonEnv } from '../python-runner.js';

function engineDirWith(script: string): string {
  const dir = join(tmpdir(), `py-runner-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tts.py'), script, 'utf8');
  return dir;
}

const JOB = {} as Parameters<ReturnType<typeof createPythonRunner>>[0];

describe('createPythonRunner', () => {
  it('kills the engine when the job is aborted', async () => {
    const enginesDir = engineDirWith('setTimeout(() => {}, 60_000);');
    const run = createPythonRunner({ pythonBin: process.execPath, enginesDir, timeoutMs: 60_000 });
    const ctrl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctrl.abort(), 200);
    const result = await run(JOB, join(enginesDir, 'out'), ctrl.signal);
    expect(result).toEqual({ kind: 'transient', reason: 'aborted' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('gives the engine HF_HOME, where the installer put the models', async () => {
    const enginesDir = engineDirWith(
      'const a = process.argv; require("fs").writeFileSync(a[a.indexOf("--result") + 1], ' +
        'JSON.stringify({ ok: true, hf_home: process.env.HF_HOME ?? null }));',
    );
    const run = createEngineRunner({ pythonBin: process.execPath, enginesDir, script: 'tts.py', timeoutMs: 30_000, hfHome: 'C:\\ag-farm\\models' });
    const result = await run({}, join(enginesDir, 'out'));
    expect(result).toEqual({ kind: 'ok', result: { ok: true, hf_home: 'C:\\ag-farm\\models' } });
    expect(pythonEnv()['HF_HOME']).toBe(process.env['HF_HOME']);
  }, 20_000);

  it('does not start the engine for an already aborted job', async () => {
    const enginesDir = engineDirWith('require("fs").writeFileSync(__dirname + "/ran", "1");');
    const run = createPythonRunner({ pythonBin: process.execPath, enginesDir, timeoutMs: 60_000 });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await run(JOB, join(enginesDir, 'out'), ctrl.signal);
    expect(result).toEqual({ kind: 'transient', reason: 'aborted before start' });
  });
});
