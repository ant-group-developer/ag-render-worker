# Engine Python: TTS (OmniVoice) và nhận dạng lời nói (WhisperX)

> **Nguồn:** Chép từ `ag-studio/engines/python/` (tts.py, transcribe.py, engine_io.py, requirements.txt), không sửa.
> `tts.py` chạy job `studio.tts`, `transcribe.py` chạy job `studio.transcribe`.
> `beats.py` (riêng của ag-render-worker, không có ở ag-studio) chạy job `studio.beats`: nhịp của nhạc nền bằng librosa,
> job `{ beats_per_bar, items: [{ track_id, audio_path, parts }] }` (WAV mono worker đổi sẵn bằng ffmpeg).
>
> ```
> python engines/python/transcribe.py --job <job.json> --result <result.json> [--dry-run]
> ```
> Job: `{ device, model, compute_type, batch_size, items: [{ source_id, audio_path, language|null }] }`.

Đây là engine TTS độc lập được ag-render-worker gọi như tiến trình con:

```
python engines/python/tts.py --job <job.json> --result <result.json> [--dry-run]
```

Exit code luôn là `0`. Mọi lỗi được báo qua `result.json` theo cấu trúc:
- `{ ok: true, lines: [...], cleaned: { chunks, bursts_cut } }` khi thành công
- `{ ok: false, kind: "contract"|"transient", reason: "..." }` khi lỗi

Trước khi ghép câu, mỗi chunk được làm sạch (`voice_clean.py`, chỉ dùng stdlib):
- Cắt một tiếng ngắn (≤ 0,6 s, sau đó lặng ≥ 0,2 s) ở đầu chunk khi cùng hình dạng đó mở đầu đủ nhiều chunk của job
  (≥ 3 chunk và ≥ 30%). Đó là tiếng mẫu giọng lọt vào câu ("outch") khi `ref_text` không khớp mẫu hoặc mẫu bị cắt
  giữa từ. Một chunk lẻ thì không cắt, vì không phân biệt được với một từ ngắn mở câu. Có cắt thì engine ghi log `warn`;
  summary của job có `voice_bursts_cut`.
- Cắt khoảng lặng trước và sau lời đọc, chỉ để lại 30 ms ở đầu và 80 ms ở cuối, rồi fade 10 ms ở hai đầu.

Test: `python -I engines/python/test_voice_clean.py` (jest gọi qua `src/__tests__/voice-clean.test.ts`).

## Cài đặt

Xem [README chính](../../README.md) để biết cách cài đặt Python venv với GPU và OmniVoice.

## Dry run (không cần GPU/torch)

```sh
python engines/python/tts.py --job test-job.json --result result.json --dry-run
```

`--dry-run` tạo WAV im lặng 0.1s mỗi line mà không cần import torch hay OmniVoice.
Dùng trong CI và tests để kiểm tra hợp đồng JSON.
