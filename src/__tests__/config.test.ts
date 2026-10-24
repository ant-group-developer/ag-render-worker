import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLE_PACKAGES } from '@ag-farm/protocol';
import { RELEASE_PACKAGE, capabilitiesOptionsFor, getExtra, resolveYtdlp } from '../config.js';
import { ffmpegFromSetup, resolveFfmpeg } from '../ffmpeg-utils.js';
import { renderBudgetSeconds } from '../render-handler.js';
import { RENDER_FEATURE_LEVEL } from '@ag-studio/render';

const nothingExists = () => false;

describe('render worker config', () => {
  test('updates itself as the package the installer and the hub know for the render role', () => {
    expect(RELEASE_PACKAGE).toBe(ROLE_PACKAGES.render);
  });

  test('reads the transcribe settings', () => {
    expect(
      getExtra({ transcribe_device: 'cuda', transcribe_compute_type: 'int8_float16', transcribe_batch_size: 4 }),
    ).toMatchObject({ transcribe_device: 'cuda', transcribe_compute_type: 'int8_float16', transcribe_batch_size: 4 });
    expect(getExtra({ transcribe_batch_size: 0 }).transcribe_batch_size).toBeUndefined();
  });

  test('reads how many mezzanines a render encodes at once, 1 to 8', () => {
    expect(getExtra({ mezz_concurrency: 4 }).mezz_concurrency).toBe(4);
    for (const bad of [0, 9, 2.5, '3', null]) expect(getExtra({ mezz_concurrency: bad }).mezz_concurrency).toBeUndefined();
  });

  test('reads how many source files a render downloads at once, 1 to 6', () => {
    expect(getExtra({ download_concurrency: 1 }).download_concurrency).toBe(1);
    for (const bad of [0, 7, 1.5, '2']) expect(getExtra({ download_concurrency: bad }).download_concurrency).toBeUndefined();
  });

  test('reads how the final pass is sliced: inputs a slice (0-64), slices at once (1-4), decoder threads (1-32)', () => {
    expect(getExtra({ final_slice_inputs: 14 }).final_slice_inputs).toBe(14);
    expect(getExtra({ final_slice_inputs: 0 }).final_slice_inputs).toBe(0);
    for (const bad of [-1, 65, 2.5, '14']) expect(getExtra({ final_slice_inputs: bad }).final_slice_inputs).toBeUndefined();
    expect(getExtra({ final_concurrency: 4 }).final_concurrency).toBe(4);
    for (const bad of [0, 5, '3']) expect(getExtra({ final_concurrency: bad }).final_concurrency).toBeUndefined();
    expect(getExtra({ decode_threads: 8 }).decode_threads).toBe(8);
    for (const bad of [0, 33, 1.5]) expect(getExtra({ decode_threads: bad }).decode_threads).toBeUndefined();
  });

  test('a render has 3 hours for a final and 1 hour for a preview unless render_budget_s (600-86400 s) says otherwise', () => {
    expect(renderBudgetSeconds('render_final', getExtra({}))).toBe(10_800);
    expect(renderBudgetSeconds('render_preview', getExtra({}))).toBe(3_600);
    expect(renderBudgetSeconds('render_final', getExtra({ render_budget_s: 14_400 }))).toBe(14_400);
    expect(renderBudgetSeconds('render_preview', getExtra({ render_budget_s: 14_400 }))).toBe(14_400);
    for (const bad of [599, 86_401, 1.5, '3600']) expect(getExtra({ render_budget_s: bad }).render_budget_s).toBeUndefined();
    // ffmpeg_timeout_s no longer bounds a render
    expect(renderBudgetSeconds('render_final', getExtra({ ffmpeg_timeout_s: 3600 }))).toBe(10_800);
  });

  test('reads the paths the installer writes', () => {
    expect(
      getExtra({ ytdlp_bin: 'C:\\ag-farm\\venv\\Scripts\\yt-dlp.exe', hf_home: 'C:\\ag-farm\\models' }),
    ).toMatchObject({ ytdlp_bin: 'C:\\ag-farm\\venv\\Scripts\\yt-dlp.exe', hf_home: 'C:\\ag-farm\\models' });
    expect(getExtra({ ytdlp_bin: '', hf_home: 3 })).toMatchObject({ ytdlp_bin: undefined, hf_home: undefined });
  });

  test('probes Python, ffmpeg and yt-dlp with the binaries the handlers run', () => {
    expect(capabilitiesOptionsFor({ python_bin: 'E:/venv/Scripts/python.exe' }, nothingExists)).toEqual({
      detectPythonTorch: true,
      pythonBin: 'E:/venv/Scripts/python.exe',
      ffmpegPath: resolveFfmpeg(),
      ytdlpBin: 'yt-dlp',
      studioRender: RENDER_FEATURE_LEVEL,
    });
    expect(RENDER_FEATURE_LEVEL).toBeGreaterThanOrEqual(1);
    expect(capabilitiesOptionsFor({}, nothingExists)).toMatchObject({ detectPythonTorch: true, pythonBin: undefined });
  });

  test('ffmpeg is the bundled binary, not a bare name on PATH', () => {
    // ffmpeg-static is a dependency: its binary is what render/TTS run
    expect(capabilitiesOptionsFor({}, nothingExists).ffmpegPath).toMatch(/[\\/]ffmpeg(\.exe)?$/);
  });

  test('the ffmpeg setup installed and tested (<app>/ffmpeg.json) when its binary is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-marker-'));
    const exe = join(dir, 'ffmpeg.exe');
    writeFileSync(exe, 'fake');
    const marker = join(dir, 'ffmpeg.json');
    writeFileSync(marker, JSON.stringify({ ffmpeg: exe, version: '8.1', nvenc: true }));
    expect(ffmpegFromSetup(marker)).toBe(exe);
    writeFileSync(marker, JSON.stringify({ ffmpeg: join(dir, 'gone.exe') }));
    expect(ffmpegFromSetup(marker)).toBeNull();
    writeFileSync(marker, '{ not json');
    expect(ffmpegFromSetup(marker)).toBeNull();
    expect(ffmpegFromSetup(join(dir, 'none.json'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test('yt-dlp: the configured one, else the one in the python_bin venv, else PATH', () => {
    expect(resolveYtdlp({ ytdlp_bin: 'D:/tools/yt-dlp.exe', python_bin: 'C:/v/Scripts/python.exe' }, () => true)).toBe(
      'D:/tools/yt-dlp.exe',
    );
    const venvScripts = join('C:/ag-farm/venv/Scripts');
    const besidePython = join(venvScripts, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    expect(resolveYtdlp({ python_bin: join(venvScripts, 'python.exe') }, (p) => p === besidePython)).toBe(besidePython);
    expect(resolveYtdlp({ python_bin: join(venvScripts, 'python.exe') }, nothingExists)).toBe('yt-dlp');
    expect(resolveYtdlp({ python_bin: 'python' }, () => true)).toBe('yt-dlp');
  });
});
