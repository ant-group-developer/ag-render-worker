/**
 * Test: runner Python bị huỷ thì tiến trình con bị kill ngay, không chạy tới hết timeout.
 * Dùng `node` thay cho python: node chạy được file tên `tts.py` như một script JS.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPythonRunner } from '../python-runner.js';

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

  it('does not start the engine for an already aborted job', async () => {
    const enginesDir = engineDirWith('require("fs").writeFileSync(__dirname + "/ran", "1");');
    const run = createPythonRunner({ pythonBin: process.execPath, enginesDir, timeoutMs: 60_000 });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await run(JOB, join(enginesDir, 'out'), ctrl.signal);
    expect(result).toEqual({ kind: 'transient', reason: 'aborted before start' });
  });
});
