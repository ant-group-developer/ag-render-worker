import { capabilitiesOptionsFor, getExtra } from '../config.js';

describe('render worker config', () => {
  test('reads the transcribe settings', () => {
    expect(
      getExtra({ transcribe_device: 'cuda', transcribe_compute_type: 'int8_float16', transcribe_batch_size: 4 }),
    ).toMatchObject({ transcribe_device: 'cuda', transcribe_compute_type: 'int8_float16', transcribe_batch_size: 4 });
    expect(getExtra({ transcribe_batch_size: 0 }).transcribe_batch_size).toBeUndefined();
  });

  test('always probes Python, with the interpreter the engines run', () => {
    expect(capabilitiesOptionsFor({ python_bin: 'E:/venv/Scripts/python.exe' })).toEqual({
      detectPythonTorch: true,
      pythonBin: 'E:/venv/Scripts/python.exe',
    });
    expect(capabilitiesOptionsFor({})).toEqual({ detectPythonTorch: true, pythonBin: undefined });
  });
});
