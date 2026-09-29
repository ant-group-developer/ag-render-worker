# Engine Python TTS (OmniVoice)

> **Nguồn:** Chép từ `ag-studio/engines/python/` (tts.py, engine_io.py, requirements.txt).
> Script `tts.py` và `engine_io.py` được dùng bởi ag-render-worker để tổng hợp giọng nói.

Đây là engine TTS độc lập được ag-render-worker gọi như tiến trình con:

```
python engines/python/tts.py --job <job.json> --result <result.json> [--dry-run]
```

Exit code luôn là `0`. Mọi lỗi được báo qua `result.json` theo cấu trúc:
- `{ ok: true, lines: [...] }` khi thành công
- `{ ok: false, kind: "contract"|"transient", reason: "..." }` khi lỗi

## Cài đặt

Xem [README chính](../../README.md) để biết cách cài đặt Python venv với GPU và OmniVoice.

## Dry run (không cần GPU/torch)

```sh
python engines/python/tts.py --job test-job.json --result result.json --dry-run
```

`--dry-run` tạo WAV im lặng 0.1s mỗi line mà không cần import torch hay OmniVoice.
Dùng trong CI và tests để kiểm tra hợp đồng JSON.
