/**
 * Test: engines/python/voice_clean.py (cắt tiếng mẫu giọng lọt vào đầu mỗi chunk TTS). Chạy unittest của nó bằng
 * Python trên PATH (chỉ cần stdlib); máy không có Python thì bỏ qua.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function findPython(): Promise<string | null> {
  for (const bin of ['python', 'python3']) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 5000 });
      return bin;
    } catch {
      // not found
    }
  }
  return null;
}

describe('voice_clean.py', () => {
  it('passes its unittests', async () => {
    const python = await findPython();
    if (!python) {
      console.log('python not on PATH, skipping');
      return;
    }
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engines', 'python', 'test_voice_clean.py');
    const { stderr } = await execFileAsync(python, ['-I', script], { timeout: 60_000 });
    expect(stderr).toMatch(/\nOK\s*$/);
  }, 90_000);
});
