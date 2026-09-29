/**
 * Test: studio.tts handler.
 * - Với Python có trên PATH: chạy engine Python ở --dry-run (không cần GPU/torch).
 * - Không có Python: dùng fake runner inject.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { makeStudioTtsHandler } from '../tts-handler.js';
import type { PythonRunner } from '../python-runner.js';
import { TtsManifestSchema } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';

const execFileAsync = promisify(execFile);

// ---- Check Python availability ----

let pythonAvailable = false;
let pythonBin = 'python';

beforeAll(async () => {
  for (const bin of ['python', 'python3']) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 5000 });
      pythonAvailable = true;
      pythonBin = bin;
      break;
    } catch {
      // not found
    }
  }
});

// ---- Fake upload / download store ----

class FakeStore {
  private readonly uploads = new Map<string, string>();  // outputPath -> localPath
  private readonly files = new Map<string, string>();     // inputName -> localPath

  addFile(name: string, path: string): void {
    this.files.set(name, path);
  }

  getUploaded(outputPath: string): string | undefined {
    return this.uploads.get(outputPath);
  }

  makeDownload(): JobContext['download'] {
    return async (name: string, dest: string) => {
      const src = this.files.get(name);
      if (!src) throw new Error(`File not found: ${name}`);
      const { copyFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    };
  }

  makeUpload(): JobContext['upload'] {
    return async (localPath: string, outputPath: string) => {
      this.uploads.set(outputPath, localPath);
    };
  }

  makeUploadJson(): JobContext['uploadJson'] {
    return async (outputPath: string, data: unknown) => {
      const tmpPath = join(tmpdir(), `upload-${randomUUID()}.json`);
      writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
      this.uploads.set(outputPath, tmpPath);
    };
  }
}

// ---- Build fake JobContext ----

function makeFakeCtx(workDir: string, store: FakeStore): JobContext {
  return {
    job: {
      id: 'job-001',
      type: 'studio.tts' as const,
      attempt: 1,
      ticket: 'ticket-001',
      lease_token: 'lease-001',
      sign_url: 'http://fake/sign',
      payload: {},
      lane: 'interactive',
    } as unknown as JobContext['job'],
    payload: {
      production_id: 'prod-001',
      language: 'vi',
      voice: { reference: null, reference_text: null, speed: 1 },
      lines: [
        { line_id: 'L001', text: 'Xin chào thế giới', pause_seconds: null },
        { line_id: 'L002', text: 'Đây là bài kiểm tra', pause_seconds: 0.5 },
      ],
      align_words: false,
    },
    workDir,
    sign: {} as unknown as JobContext['sign'],
    cache: {} as unknown as JobContext['cache'],
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => ({} as unknown as ReturnType<JobContext['log']['child']>),
      } as unknown as ReturnType<JobContext['log']['child']>),
    } as unknown as JobContext['log'],
    signal: new AbortController().signal,
    progress: () => {},
    download: store.makeDownload(),
    upload: store.makeUpload(),
    uploadJson: store.makeUploadJson(),
  };
}

// ---- Tests ----

describe('studio.tts handler', () => {
  let workDir: string;
  let store: FakeStore;
  let ctx: JobContext;

  beforeEach(() => {
    workDir = join(tmpdir(), `tts-test-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true });
    store = new FakeStore();
    ctx = makeFakeCtx(workDir, store);
  });

  test('with fake runner: uploads tts/L001.wav, tts/L002.wav, and tts.json', async () => {
    // Fake runner: trả WAV paths tạm (0-byte là OK cho test upload)
    const fakeRunner: PythonRunner = async (job, outDir) => {
      const lines = [];
      for (const line of job.lines) {
        const wavPath = line.out_path;
        // Tạo file WAV tối giản (44 bytes header đơn giản)
        writeFileSync(wavPath, Buffer.alloc(100));
        lines.push({
          line_id: line.line_id,
          wav_path: wavPath,
          duration_seconds: 0.5,
          chunks: [{ text: line.chunks[0] ?? '', start: 0, end: 0.5 }],
          words: null,
          alignment: 'chunk' as const,
        });
      }
      return { kind: 'ok', result: { lines } };
    };

    const handler = makeStudioTtsHandler({ runner: fakeRunner });
    const result = await handler(ctx);

    // Kết quả phải có manifest path
    expect(result.manifest).toBe('tts.json');

    // Phải upload 2 WAV files
    expect(store.getUploaded('tts/L001.wav')).toBeTruthy();
    expect(store.getUploaded('tts/L002.wav')).toBeTruthy();

    // Phải upload tts.json
    const manifestPath = store.getUploaded('tts.json');
    expect(manifestPath).toBeTruthy();

    // Validate manifest
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(manifestPath!, 'utf8'));
    const parsed = TtsManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.production_id).toBe('prod-001');
      expect(parsed.data.language).toBe('vi');
      expect(parsed.data.lines).toHaveLength(2);
      expect(parsed.data.lines[0]!.line_id).toBe('L001');
      expect(parsed.data.lines[1]!.line_id).toBe('L002');
    }
  });

  test('runner returns contract error → NonRetryableError', async () => {
    const fakeRunner: PythonRunner = async () => ({
      kind: 'contract',
      reason: 'model not found',
    });

    const handler = makeStudioTtsHandler({ runner: fakeRunner });
    await expect(handler(ctx)).rejects.toThrow('model not found');
  });

  test('runner returns transient error → retryable Error', async () => {
    const fakeRunner: PythonRunner = async () => ({
      kind: 'transient',
      reason: 'out of memory',
    });

    const handler = makeStudioTtsHandler({ runner: fakeRunner });
    await expect(handler(ctx)).rejects.toThrow(/transient/);
  });

  test(
    'with real Python --dry-run (skipped if no Python)',
    async () => {
      if (!pythonAvailable) {
        console.log('Python not available, skipping real Python test');
        return;
      }

      // Import dirname và fileURLToPath để tìm engines dir
      const { dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');

      // Tìm engines/python từ src/__tests__/ → src/ → ../ → engines/python
      const enginesDir = join(
        dirname(fileURLToPath(import.meta.url)),
        '..', '..', 'engines', 'python',
      );

      if (!existsSync(enginesDir)) {
        console.log(`engines/python not found at ${enginesDir}, skipping`);
        return;
      }

      const { createPythonRunner } = await import('../python-runner.js');
      const runner = createPythonRunner({
        pythonBin,
        enginesDir,
        timeoutMs: 30_000,
        dryRun: true,
      });

      const handler = makeStudioTtsHandler({ runner, enginesDir });
      const result = await handler(ctx);

      expect(result.manifest).toBe('tts.json');

      const manifestPath = store.getUploaded('tts.json');
      expect(manifestPath).toBeTruthy();

      const { readFileSync } = await import('node:fs');
      const manifest = JSON.parse(readFileSync(manifestPath!, 'utf8'));
      const parsed = TtsManifestSchema.safeParse(manifest);
      expect(parsed.success).toBe(true);

      if (parsed.success) {
        expect(parsed.data.lines).toHaveLength(2);
        // dry-run tạo WAV 0.1s mỗi line
        expect(parsed.data.lines[0]!.duration_s).toBeCloseTo(0.1, 1);
      }
    },
    60_000,
  );
});
