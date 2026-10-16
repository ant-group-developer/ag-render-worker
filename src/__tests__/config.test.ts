import { join } from 'node:path';
import { ROLE_PACKAGES } from '@ag-farm/protocol';
import { RELEASE_PACKAGE, capabilitiesOptionsFor, getExtra, resolveYtdlp } from '../config.js';
import { resolveFfmpeg } from '../ffmpeg-utils.js';
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
