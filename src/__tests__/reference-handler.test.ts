/**
 * Test: studio.reference_fetch handler, with a fake yt-dlp (fixtures/fake-yt-dlp.mjs): no network.
 * - the exact arguments Studio uses (no cookies, ≤ 480p, worker's Node as JS runtime);
 * - upload, summary, and no file left on the machine;
 * - YouTube's refusals as the same codes Studio's classifyYtDlp gives (same sample messages);
 * - cancellation and timeout.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StudioReferenceFetchResultSchema } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { errorToJobError, JobFailure, NonRetryableError } from '@ag-farm/worker-sdk';
import { makeStudioReferenceFetchHandler } from '../reference-handler.js';
import { classifyYtDlp, downloadArgs, maxFilesizeArg, ytdlpCommonArgs } from '../yt-dlp.js';
import { resolveFfmpeg, resolveFfprobe } from '../ffmpeg-utils.js';

const FAKE = [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-yt-dlp.mjs')];
const FFMPEG = resolveFfmpeg();
const FFPROBE = resolveFfprobe();
const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE);
const itMedia = HAS_FFMPEG ? it : it.skip;

const SILENT = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Studio's download() arguments, word for word (ag-studio packages/studio-engine/src/yt-dlp.ts). */
function studioArgs(id: string, dir: string, ffmpeg: string): string[] {
  return [
    '--ignore-config', '--no-cookies', '--no-warnings', '--no-progress', '--js-runtimes', `node:${process.execPath}`,
    '--no-playlist', '--no-part', '--restrict-filenames',
    '-f', 'bv*[height<=480]+ba/b[height<=480]/bv*[height<=480]', '--merge-output-format', 'mp4',
    '--max-filesize', '300M', '--match-filter', 'duration<=1800 & !is_live',
    '--ffmpeg-location', ffmpeg,
    '-o', join(dir, `${id}.%(ext)s`), '--', `https://www.youtube.com/watch?v=${id}`,
  ];
}

interface Harness {
  ctx: JobContext;
  uploads: Map<string, { bytes: number; contentType: string }>;
  progress: string[];
  abort: AbortController;
  workDir: string;
}

function harness(payload: unknown): Harness {
  const workDir = join(tmpdir(), `reference-test-${randomUUID()}`, 'work');
  mkdirSync(workDir, { recursive: true });
  const uploads = new Map<string, { bytes: number; contentType: string }>();
  const progress: string[] = [];
  const abort = new AbortController();
  const ctx = {
    job: { id: 'job-1', type: 'studio.reference_fetch', attempt: 1 } as unknown as JobContext['job'],
    payload,
    workDir,
    sign: {} as unknown as JobContext['sign'],
    cache: {} as unknown as JobContext['cache'],
    log: { ...SILENT, child: () => ({ ...SILENT, child: () => SILENT }) } as unknown as JobContext['log'],
    signal: abort.signal,
    progress: (_p?: number, stage?: string) => { if (stage) progress.push(stage); },
    shouldYield: () => false,
    yieldToInteractive: async () => {},
    download: (async () => { throw new Error('no inputs'); }) as JobContext['download'],
    upload: (async (local: string, output: string, contentType: string) => {
      uploads.set(output, { bytes: readFileSync(local).length, contentType });
    }) as JobContext['upload'],
    uploadJson: (async () => {}) as JobContext['uploadJson'],
  } as unknown as JobContext;
  return { ctx, uploads, progress, abort, workDir };
}

const payload = (video_id: string, more: Record<string, unknown> = {}) => ({
  production_id: 'prod-1', video_id, output: `reference/${video_id}.mp4`, ...more,
});

const handler = (more: Parameters<typeof makeStudioReferenceFetchHandler>[0] = {}) =>
  makeStudioReferenceFetchHandler({ ytdlpArgv: FAKE, ffmpeg: FFMPEG, ffprobe: FFPROBE, ...more });

async function failureOf(p: Promise<unknown>): Promise<{ code: string; message: string; retryable: boolean }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  return errorToJobError(err);
}

describe("yt-dlp's arguments", () => {
  it("are Studio's exactly, plus --write-info-json for the title and channel", () => {
    const dir = join(tmpdir(), 'x');
    const ours = downloadArgs({ videoId: 'U_17EqTHUIo', dir, join, maxHeight: 480, maxSeconds: 1800, maxBytes: 300 * 1024 * 1024, ffmpeg: FFMPEG });
    expect(ours.filter((a) => a !== '--write-info-json')).toEqual(studioArgs('U_17EqTHUIo', dir, FFMPEG));
    expect(ours).toContain('--write-info-json');
    expect(ours).not.toContain('--cookies');
    expect(ours).not.toContain('--cookies-from-browser');
  });

  it("YouTube gets the worker's own Node as its JavaScript runtime; no config file, no cookies", () => {
    const common = ytdlpCommonArgs();
    expect(common[common.indexOf('--js-runtimes') + 1]).toBe(`node:${process.execPath}`);
    expect(common).toEqual(expect.arrayContaining(['--ignore-config', '--no-cookies']));
  });

  it('tighter limits from the payload; the size in MiB as Studio writes it', () => {
    const a = downloadArgs({ videoId: 'abcdefghijk', dir: 'd', join, maxHeight: 360, maxSeconds: 600, maxBytes: 100 * 1024 * 1024 });
    expect(a).toEqual(expect.arrayContaining(['bv*[height<=360]+ba/b[height<=360]/bv*[height<=360]', 'duration<=600 & !is_live', '100M']));
    expect(a).not.toContain('--ffmpeg-location');
    expect(maxFilesizeArg(300 * 1024 * 1024)).toBe('300M');
    expect(maxFilesizeArg(1_500_000)).toBe('1500000');
  });

  it('never builds a URL from something that is not an id', () => {
    expect(() => downloadArgs({ videoId: '--exec=calc', dir: 'd', join, maxHeight: 480, maxSeconds: 1, maxBytes: 1 })).toThrow(/not a YouTube video id/);
  });
});

describe('classifyYtDlp (same samples as Studio)', () => {
  const c = (text: string) => classifyYtDlp(text).code;
  it('names each way YouTube says no', () => {
    expect(c('ERROR: [youtube] U_17EqTHUIo: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.')).toBe('youtube_blocked');
    expect(c('ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests')).toBe('youtube_blocked');
    expect(c('ERROR: [youtube] abcdefghijk: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies')).toBe('age_restricted');
    expect(c('ERROR: [youtube] abcdefghijk: Join this channel to get access to members-only content like this video')).toBe('members_only');
    expect(c("ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access")).toBe('private');
    expect(c('ERROR: [youtube] abcdefghijk: This live event will begin in 3 hours.')).toBe('live');
    expect(c('[download] Kyoto does not pass filter (duration<=1800 & !is_live), skipping ..')).toBe('too_long');
    expect(c('[download] File is larger than max-filesize (400000000 bytes > 300M). Aborting.')).toBe('too_big');
    expect(c('ERROR: [youtube] abcdefghijk: Requested format is not available. Use --list-formats')).toBe('no_480p');
    expect(c('ERROR: [youtube] abcdefghijk: Unable to download API page: <urlopen error [Errno -3] Temporary failure in name resolution>')).toBe('network');
  });

  it('a bot check on any line wins; something else keeps the START of its ERROR line', () => {
    expect(c("ERROR: [youtube] aaaaaaaaaaa: Video unavailable\nERROR: [youtube] bbbbbbbbbbb: Sign in to confirm you're not a bot")).toBe('youtube_blocked');
    const long = `ERROR: [youtube] abcdefghijk: Something new went wrong ${'x'.repeat(400)} the end`;
    const f = classifyYtDlp(`WARNING: noise\n${long}\nsome trailing line`);
    expect(f.code).toBe('other');
    expect(f.reason.startsWith('yt-dlp: Something new went wrong')).toBe(true);
    expect(f.reason.length).toBeLessThanOrEqual(210);
    expect(f.reason).not.toContain('the end');
  });
});

describe('studio.reference_fetch handler (fake yt-dlp)', () => {
  itMedia('downloads at most 480p, uploads it, says what it is, and leaves nothing on the machine', async () => {
    const h = harness(payload('U_17EqTHUIo'));
    const result = await handler()(h.ctx);
    expect(result.manifest).toBeNull();
    const summary = StudioReferenceFetchResultSchema.parse(result.summary);
    expect(summary).toMatchObject({
      output: 'reference/U_17EqTHUIo.mp4', ext: 'mp4', width: 320, height: 240, title: 'Fake video U_17EqTHUIo', channel: 'Fake Channel',
    });
    expect(summary.duration_s).toBeGreaterThan(1.5);
    expect(summary.duration_s).toBeLessThan(2.5);
    expect(h.uploads.get('reference/U_17EqTHUIo.mp4')).toEqual({ bytes: summary.size_bytes, contentType: 'video/mp4' });
    expect(h.uploads.size).toBe(1);
    expect(h.progress).toEqual(['download', 'probe', 'upload']);
    expect(existsSync(join(h.workDir, 'reference'))).toBe(false);
  });

  itMedia('runs yt-dlp with exactly those arguments', async () => {
    const out = join(tmpdir(), `fake-args-${randomUUID()}.json`);
    process.env['FAKE_YTDLP_ARGS_OUT'] = out;
    try {
      const h = harness(payload('U_17EqTHUIo'));
      await handler()(h.ctx);
      const got = JSON.parse(readFileSync(out, 'utf8')) as string[];
      const dir = join(h.workDir, 'reference');
      expect(got.filter((a) => a !== '--write-info-json')).toEqual(studioArgs('U_17EqTHUIo', dir, FFMPEG));
    } finally {
      delete process.env['FAKE_YTDLP_ARGS_OUT'];
    }
  });

  itMedia('a webm (no merge needed) goes up as webm', async () => {
    const h = harness(payload('WEBMvideo00'));
    const result = await handler()(h.ctx);
    expect(result.summary).toMatchObject({ ext: 'webm' });
    expect(h.uploads.get('reference/WEBMvideo00.mp4')?.contentType).toBe('video/webm');
  });

  it("a refused download fails with Studio's code; only the network is retried", async () => {
    const cases: [string, string, boolean][] = [
      ['BOTblocked1', 'youtube_blocked', false],
      ['ERRgone0000', 'unavailable', false],
      ['PRIVate0000', 'private', false],
      ['AGEcheck000', 'age_restricted', false],
      ['LONGvideo00', 'too_long', false],
      ['BIGvideo000', 'too_big', false],
      ['NETdown0000', 'network', true],
    ];
    for (const [id, code, retryable] of cases) {
      const h = harness(payload(id));
      const e = await failureOf(handler()(h.ctx));
      expect({ id, code: e.code, retryable: e.retryable }).toEqual({ id, code, retryable });
      expect(h.uploads.size).toBe(0);
      expect(existsSync(join(h.workDir, 'reference'))).toBe(false);
    }
  });

  it("keeps the start of yt-dlp's words as the message (the bot check that blocks the server)", async () => {
    const e = await failureOf(handler()(harness(payload('BOTblocked1')).ctx));
    expect(e.message).toMatch(/^Sign in to confirm you.re not a bot/);
    expect(e.message.length).toBeLessThanOrEqual(200);
  });

  it('a bad payload is not retried and yt-dlp never runs', async () => {
    const out = join(tmpdir(), `fake-args-${randomUUID()}.json`);
    process.env['FAKE_YTDLP_ARGS_OUT'] = out;
    try {
      for (const bad of [payload('../../etc/x'), payload('https://youtu.be/U_17EqTHUIo'), { ...payload('U_17EqTHUIo'), max_height: 1080 }]) {
        const err = await handler()(harness(bad).ctx).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NonRetryableError);
      }
      expect(existsSync(out)).toBe(false);
    } finally {
      delete process.env['FAKE_YTDLP_ARGS_OUT'];
    }
  });

  it('a timeout is a retryable timeout', async () => {
    const e = await failureOf(handler({ timeoutMs: 1500 })(harness(payload('SLOWvideo00')).ctx));
    expect(e).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('stops when the job is cancelled, without a failure code', async () => {
    const h = harness(payload('SLOWvideo00'));
    const run = handler()(h.ctx).then(() => null, (e: unknown) => e);
    setTimeout(() => h.abort.abort(), 500);
    const err = await run;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(JobFailure);
    expect(h.uploads.size).toBe(0);
    // the folder goes even when the killed process held it a moment
    expect(readdirSync(h.workDir).includes('reference') ? readdirSync(join(h.workDir, 'reference')) : []).toEqual([]);
  });
});
