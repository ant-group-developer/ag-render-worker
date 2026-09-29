# ag-render-worker

Worker dựng video cho AG Studio, chạy trên máy cấu hình cao.

Nhận job từ [ag-farm](../ag-farm) và xử lý ba loại việc:
- `studio.tts` — tổng hợp giọng nói (OmniVoice TTS)
- `studio.render_preview` — dựng preview 720p
- `studio.render_final` — dựng bản gốc chất lượng cao

---

## Yêu cầu hệ thống

| Thành phần | Phiên bản tối thiểu | Ghi chú |
|---|---|---|
| Node.js | 22 (khuyến nghị 24) | Dùng `corepack enable` để bật pnpm |
| ffmpeg | 6+ | Cần có trong PATH hoặc đặt `FFMPEG_PATH` |
| Python | 3.11+ | Chỉ cần cho `studio.tts` |
| torch + CUDA | torch 2.8.0+cu126 | Cần GPU NVIDIA ≥ RTX 3060 12GB cho TTS thật |
| OmniVoice | ≥ 0.2.1, < 0.3 | TTS model |
| Font | Noto Sans (vi) hoặc font của team | Dùng trong render composition |

Máy không có GPU: worker chạy bình thường nhưng TTS sẽ rất chậm (CPU inference).
Để bỏ qua TTS thật, dùng `--dry-run` ở môi trường CI.

---

## Cài đặt

### 1. Clone và cài Node deps

```sh
git clone https://github.com/your-org/ag-render-worker
cd ag-render-worker
corepack enable
pnpm install   # hoặc yarn install
```

### 2. Build @ag-studio/render

Worker phụ thuộc vào `@ag-studio/render` (link local). Cần build trước:

```sh
cd ../ag-studio
corepack pnpm --filter @ag-studio/render... build
cd ../ag-render-worker
```

### 3. Cài Python venv (máy GPU)

```sh
# Giữ cache ngoài ổ hệ thống (tuỳ chọn nhưng khuyến nghị)
export PIP_CACHE_DIR=E:/pip-cache HF_HOME=E:/hf-cache

# Tạo venv
python3.11 -m venv E:/render-venv
P=E:/render-venv/Scripts/python

# Cài torch CUDA trước
$P -m pip install torch==2.8.0 torchaudio==2.8.0 \
  --index-url https://download.pytorch.org/whl/cu126

# Cài OmniVoice + WhisperX
$P -m pip install -r engines/python/requirements.txt

# Kiểm tra
$P -c "import torch, omnivoice; print(torch.__version__, torch.cuda.is_available())"
```

### 4. Cấu hình

Tạo file `config.yaml`:

```yaml
# Kết nối ag-farm
hub_url: https://farm.example.com
token: <token-node-từ-ag-farm-web>
name: render-worker-pc1

# Loại job
kinds:
  - studio.tts
  - studio.render_preview
  - studio.render_final

# Thư mục
work_dir: E:/ag-render-worker/work
cache:
  dir: E:/ag-render-worker/cache
  max_gb: 100

# Cấu hình riêng của render worker
extra:
  python_bin: E:/render-venv/Scripts/python
  python_timeout_s: 600
  unload_ollama_before_tts: true   # bật nếu cùng máy với ag-scan-worker
  ollama_url: http://localhost:11434
  ffmpeg_timeout_s: 3600
```

---

## Chạy

### Thủ công

```sh
node dist/main.js --config config.yaml
```

### Cài dịch vụ Windows (NSSM)

```powershell
nssm install ag-render-worker "node" "E:\ag-render-worker\dist\main.js --config E:\ag-render-worker\config.yaml"
nssm set ag-render-worker AppDirectory "E:\ag-render-worker"
nssm set ag-render-worker AppEnvironmentExtra "FFMPEG_PATH=E:\tools\ffmpeg\ffmpeg.exe"
nssm set ag-render-worker AppStdout "E:\ag-render-worker\logs\out.log"
nssm set ag-render-worker AppStderr "E:\ag-render-worker\logs\err.log"
nssm start ag-render-worker
```

### Cài dịch vụ Linux (systemd)

```ini
[Unit]
Description=AG Render Worker
After=network.target

[Service]
User=ag-worker
WorkingDirectory=/opt/ag-render-worker
ExecStart=/usr/bin/node dist/main.js --config /etc/ag-farm/render-worker.yaml
Environment=FFMPEG_PATH=/usr/local/bin/ffmpeg
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## Chạy chung máy với ag-scan-worker

Hai worker dùng chung file `machine.yaml` để phối hợp slot CPU/GPU:

### machine.yaml (Windows: `C:\ProgramData\ag-farm\machine.yaml`, Linux: `/etc/ag-farm/machine.yaml`)

```yaml
cpu_slots: 4
gpu_slots: 1
reserve_interactive:
  cpu: 1   # giữ 1 slot CPU cho job interactive (render)
  gpu: 0
```

### Tranh VRAM giữa scan-worker và render-worker

- ag-scan-worker dùng Ollama (Qwen-VL) để mô tả footage → ăn VRAM
- ag-render-worker dùng OmniVoice TTS → cũng ăn VRAM

Khi cấu hình `unload_ollama_before_tts: true`, render worker sẽ gọi Ollama API để giải phóng model trước khi chạy TTS. Trong scan worker, đặt `keep_alive: 0` ngắn để Ollama tự giải phóng khi không có việc.

Nếu VRAM không đủ cho cả hai: ưu tiên render (interactive) bằng cách tắt `scan.ai` trong `kinds` của máy đó.

### GPU lock

ag-farm SDK dùng file lock chung (`machine.yaml` + advisory lock) để hai worker không tranh GPU cùng lúc. Cấu hình `gpu_slots: 1` là đủ để đảm bảo điều này.

---

## Tests

```sh
# Chạy tất cả tests (cần ffmpeg trên PATH hoặc FFMPEG_PATH)
pnpm test

# Chạy tests không cần GPU/torch
# - payload-validation.test.ts: chỉ kiểm zod schema → luôn pass
# - composition-utils.test.ts: logic thuần → luôn pass
# - tts-handler.test.ts: inject fake runner → luôn pass; dry-run nếu có Python
# - render-handler.test.ts: cần ffmpeg để tạo và render lavfi clip
```

---

## Kiểm mojibake

Chạy lệnh kiểm sau để xác nhận không có chuỗi UTF-8 bị mã hóa sai (mojibake) trong src và README:

```sh
# Lệnh kiểm: tìm pattern mojibake; phải không có kết quả
grep -rE "MOJIBAKE_PATTERN" src README.md
```

(Mô tả pattern: tìm chuỗi UTF-8 bị encode sai dạng Latin-1. Xem CI script `scripts/check-encoding.sh`.)
