# ag-render-worker

Worker dựng video cho AG Studio, chạy trên máy cấu hình cao.

Nhận job từ [ag-farm](../ag-farm) và xử lý sáu loại việc:
- `studio.tts` — tổng hợp giọng nói (OmniVoice TTS)
- `studio.transcribe` — nhận dạng lời nói trong footage (WhisperX), cho kiểu dựng cắt theo shot
- `studio.export_premiere` — xuất project Adobe Premiere
- `studio.render_preview` — dựng bản xem trước: cùng khung với bản cuối, mã hoá nhẹ để xem trên trình duyệt (từ 0.9.1:
  NVENC `p4 cq 25` / x264 `veryfast crf 24`, tối đa 6 Mbit/s; mezzanine và cache dùng chung với bản cuối)
- `studio.render_final` — dựng bản gốc chất lượng cao
- `studio.reference_fetch` — tải video YouTube mẫu (≤ 480p, ≤ 30 phút, ≤ 300 MB) cho Studio đo kiểu dựng khi YouTube
  chặn máy chủ Studio; yt-dlp chạy đúng cờ của Studio (không cookie, không đăng nhập), file đẩy lên rồi xoá ngay trên
  máy. Chỉ máy có yt-dlp nhận loại này.

---

## Cài trên máy worker (Windows)

Không cài tay. Trang **Máy** của web farm → **Thêm máy** cho một lệnh; dán vào PowerShell mở bằng
"Run as Administrator":

```powershell
iwr https://<farm>/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub https://<farm> -Code <mã>
```

Cập nhật lên bản mới: cùng lệnh, bỏ `-Code`. Cài và cập nhật đều chạy `deploy\setup-render.ps1` của gói (chạy lại bao
nhiêu lần cũng được):

- Python 3.11 (thiếu thì tự cài cho mọi user: winget, không có thì bộ cài python.org), venv `C:\ag-farm\venv`;
- `yt-dlp` trong venv, mỗi lần cập nhật nâng lên bản mới nhất;
- máy có GPU NVIDIA: torch 2.8.0 CUDA 12.6 + `engines/python/requirements.txt` (OmniVoice, WhisperX), kiểm
  `import torch, omnivoice, whisperx` và CUDA, tải trước model OmniVoice và Whisper `large-v3` vào `C:\ag-farm\models`
  (`HF_HOME` của worker). requirements và bản torch không đổi thì bỏ qua pip (dấu `venv\ag-setup.stamp`);
- log ở `C:\ag-farm\logs\setup.log`, kết quả ở `C:\ag-farm\logs\setup-result.json`.

Máy không có GPU NVIDIA vẫn dựng video (`studio.render_*`, `studio.export_premiere`), không nhận `studio.tts` và
`studio.transcribe`.

Sau mỗi lần cài/cập nhật, `C:\ag-farm\render\config.yaml` được ghi lại: giữ `name`, `token`, `hub_url`, `cache`,
`schedule` và mọi khoá anh tự thêm (kể cả trong `extra`); viết lại các khoá installer quản lý trong `extra`
(`python_bin`, `ytdlp_bin`, `hf_home`, `encoder`, `ollama_url`, `unload_ollama_before_tts`); bỏ danh sách `kinds`. Bản
trước lưu ở `config.yaml.bak`.

### Tự cập nhật

Từ 0.9.0, máy tự lên bản mới khi farm phát hành: mỗi 15 phút worker xem `/dist/latest.json` của hub, có bản mới hơn
(và trang **Máy** đang bật "Tự cập nhật" cho máy này, hoặc admin bấm "Cập nhật ngay") thì ngừng nhận việc, chờ việc
đang chạy xong (tối đa 30 phút), rồi chạy task `ag-farm-updater`. Task cài bản mới như lệnh cập nhật, kể cả
`setup-render.ps1` (giữ bản cũ ở `C:\ag-farm\render\app.prev`); bản mới không kết nối hub trong 3 phút thì quay về bản
cũ. Kết quả, lỗi và dòng cuối `setup.log` hiện ở trang **Máy**; log ở `C:\ag-farm\updater\updater.log`. Đổi chu kỳ/thời
gian chờ: `update_check_minutes`, `update_drain_minutes` trong `config.yaml` (installer giữ giá trị anh đặt).

Máy đang chạy 0.8.1 trở về trước chưa có bộ cập nhật: chạy lệnh cập nhật ở trên (bỏ `-Code`) **một lần cuối** bằng tay.

### Tình trạng máy

Từ 0.9.0, worker đo máy mỗi 15 giây (CPU, RAM, ổ chứa `work_dir`/cache, mạng vào/ra, GPU qua `nvidia-smi`) và gửi kèm
heartbeat; trang **Máy** của farm hiện các số này và biểu đồ 1 giờ / 24 giờ / 7 ngày. Không cần cài thêm gì; tắt bằng
`metrics: false` trong `config.yaml`. Hub farm phải lên bản có số đo trước (hub cũ từ chối thì worker tự thôi gửi số đo
trong một giờ, vẫn nhận việc bình thường).

### Phát hành bản mới (máy build Windows)

Tăng `version` trong `package.json` (hub từ chối bản không mới hơn bản đang phát hành), build `@ag-studio/render`, rồi:

```powershell
$env:FARM_RELEASE_KEY = '<FARM_RELEASE_KEY của hub>'   # chỉ trong phiên này, không ghi vào file
node scripts/release.mjs --publish --upload https://api-farm.ant-group.net
```

Script đóng gói rồi đẩy zip lên hub (`POST /v1/admin/releases`); hub kiểm sha256, lưu gói và `latest.json`, các máy tự
cập nhật trong khoảng 15 phút. Hub khác dùng biến khác: `--key-env FARM_DEV_RELEASE_KEY`. Không còn chép tay lên VPS
bằng scp; `--publish <thư mục>` vẫn chép vào một thư mục latest.json nếu cần.

Gói có font OFL cho chữ trên video (`fonts/`, danh sách `fonts/fonts.json`): `release.mjs` tự tải file còn thiếu từ
google/fonts và kiểm sha256. File `.ttf` không nằm trong git. Thêm hoặc đổi bản một font: sửa `fonts.json` (để
`sha256: null`), chạy `node scripts/fetch-fonts.mjs --pin` một lần rồi commit `fonts.json`.

### Kiểm các máy sau mỗi lần phát hành

Studio chỉ gửi một bản render cho máy khai đủ **mức render** (`engines.studio_render`, `RENDER_FEATURE_LEVEL` của
`@ag-studio/render`): máy chưa lên bản mới không nhận job mới, job nằm chờ trong hàng tới
`STUDIO_FARM_QUEUE_TIMEOUT_MINUTES`. Nên khoảng 20 phút sau khi phát hành, kiểm mọi máy đang bật:

1. Web farm, trang **Máy**: cột phiên bản của mọi máy online là bản vừa phát hành (máy cũ có nhãn "cần cập nhật"; bấm
   "Cập nhật ngay" hoặc chạy lại lệnh cài, bỏ `-Code`, trên máy đó).
2. Mức render và loại job từng máy, qua API admin của hub. Lấy token: mở web farm (đã đăng nhập admin) → DevTools →
   Console, chạy
   `Object.keys(localStorage).filter((k) => k.startsWith('@@auth0spajs@@')).map((k) => JSON.parse(localStorage[k]).body?.access_token).find(Boolean)`
   và chép chuỗi in ra. Rồi trong PowerShell:

```powershell
$token = '<chuỗi vừa chép>'
$r = Invoke-RestMethod -Uri 'https://api-farm.ant-group.net/v1/admin/nodes?status=active&pageSize=200' -Headers @{ Authorization = "Bearer $token" }
$r.items | Select-Object name, online, agent_version, @{ n = 'studio_render'; e = { $_.engines.studio_render } }, @{ n = 'python'; e = { [bool]$_.engines.python } }, @{ n = 'kinds'; e = { $_.kinds -join ',' } } | Format-Table -AutoSize
```

   Máy online nào có `agent_version` cũ hoặc `studio_render` thấp hơn mức của bản vừa phát hành thì chưa nhận bản render
   mới. Bản mới mà `studio_render` vẫn thấp hơn mức của bản: worker tự kiểm thấy thiếu font (`fonts/` của gói); máy có
   GPU mà `python` false hoặc không có `studio.tts`/`studio.transcribe` trong `kinds`: thiếu engine Python hoặc
   Python không import được torch. Cả hai trường hợp xem dòng `[self-check]` đầu `C:\ag-farm\render\logs\worker.log`
   của máy đó, rồi cài lại bản mới nhất.
3. Bản xem trước nhẹ (tier `preview`, tối đa 6 Mbit/s, từ 0.9.1): một bản xem trước 10 phút nặng quá ~450 MB là máy render
   nó còn bản cũ.

Worker tự kiểm khi khởi động (`src/self-check.ts`): thiếu `engines/python/tts.py`, `transcribe.py` hay `engine_io.py`
thì log lỗi và không khai Python (hub không giao `studio.tts`/`studio.transcribe`); thiếu font đóng kèm thì log lỗi và khai
mức render ngay dưới mức font; thiếu Arial thì log lỗi.

### Loại job máy nhận

Không khai `kinds`: worker báo mọi loại job nó có handler **và** máy đủ điều kiện theo `JOB_TYPE_SPECS` (GPU, Python
import được torch, NVENC, yt-dlp), dò lúc worker khởi động (tức là sau mỗi lần cài/cập nhật). Không muốn máy nhận một
loại: tắt công tắc của loại đó ở trang **Máy**. `kinds` trong config vẫn dùng được để ép danh sách (giao với handler).

### Thư mục

| Đường dẫn | Nội dung |
|---|---|
| `C:\ag-farm\render\app` | gói worker (Node riêng, ffmpeg kèm theo, engine Python) |
| `C:\ag-farm\render\config.yaml` | cấu hình (token chỉ nằm ở đây) |
| `C:\ag-farm\render\logs\worker.log` | log worker |
| `C:\ag-farm\venv` | Python của TTS / nhận dạng lời nói / yt-dlp |
| `C:\ag-farm\models` | model Hugging Face (OmniVoice, Whisper) |
| `C:\ProgramData\ag-farm\machine.yaml` | slot dùng chung với ag-scan-worker |

Worker chạy bằng task hệ thống `ag-farm-render` (tài khoản SYSTEM, tự chạy khi bật máy, chết thì chạy lại).
`deploy/install-windows.ps1` (dịch vụ NSSM) là cách cài cũ, không dùng nữa; installer tự gỡ dịch vụ NSSM cũ.

---

## Phát triển (máy dev)

| Thành phần | Phiên bản |
|---|---|
| Node.js | 22+ |
| Python | 3.11, chỉ cần khi chạy engine thật (`studio.tts`, `studio.transcribe`) |
| GPU | NVIDIA ≥ RTX 3060 12 GB cho TTS thật; không có thì dùng `--dry-run` ở CI |

ffmpeg/ffprobe lấy từ `ffmpeg-static`/`ffprobe-static` (hoặc `FFMPEG_PATH`/`FFPROBE_PATH`), không cần trên PATH.

```sh
git clone https://github.com/your-org/ag-render-worker
cd ag-render-worker
yarn install
# @ag-studio/render (link local) phải build trước
(cd ../ag-studio && corepack pnpm --filter @ag-studio/render... build)
```

Venv Python giống máy worker, vào một thư mục tuỳ chọn:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\setup-render.ps1 -InstallDir E:\ag-dev [-SkipGpu] [-SkipModels]
# → E:\ag-dev\venv\Scripts\python.exe, E:\ag-dev\venv\Scripts\yt-dlp.exe, E:\ag-dev\models
```

`config.yaml` cho máy dev (mẫu đủ khoá: `deploy/config.example.yaml`):

```yaml
hub_url: https://farm.example.com
token: <token-node-từ-ag-farm-web>
name: render-dev
work_dir: 'E:\ag-dev\render\work'
cache:
  dir: 'E:\ag-dev\render\cache'
  max_gb: 100
extra:
  python_bin: 'E:\ag-dev\venv\Scripts\python.exe'
  ytdlp_bin: 'E:\ag-dev\venv\Scripts\yt-dlp.exe'
  hf_home: 'E:\ag-dev\models'
  unload_ollama_before_tts: true   # bật nếu cùng máy với ag-scan-worker
  ollama_url: http://localhost:11434
```

```sh
yarn build && node dist/main.js --config config.yaml
```

### Linux (systemd, cài tay)

Installer chỉ có cho Windows. Trên Linux: venv như trên (`python3.11 -m venv`, torch CUDA trước rồi
`pip install -r engines/python/requirements.txt yt-dlp`), rồi:

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

Nếu VRAM không đủ cho cả hai: ưu tiên render (interactive) bằng cách tắt `scan.ai` của máy đó ở trang **Máy**.

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
