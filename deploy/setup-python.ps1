# Cài môi trường Python cho TTS (OmniVoice) trên máy GPU. Chạy một lần, đứng ở thư mục đã giải nén:
#   powershell -ExecutionPolicy Bypass -File deploy\setup-python.ps1 [-Venv D:\ag-farm\venv] [-Python py]
# Sau đó đặt extra.python_bin trong config.yaml = <Venv>\Scripts\python.exe
param(
  [string]$Venv = "D:\ag-farm\venv",
  [string]$Python = "py"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path "$Venv\Scripts\python.exe")) {
  & $Python -3.11 -m venv $Venv
  if ($LASTEXITCODE -ne 0) { throw "Không tạo được venv (cần Python 3.11: https://www.python.org)" }
}
$P = "$Venv\Scripts\python.exe"
& $P -m pip install --upgrade pip
# torch bản CUDA 12.6 trước, rồi OmniVoice
& $P -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126
& $P -m pip install -r "$root\engines\python\requirements.txt"
& $P -c "import torch, omnivoice; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
Write-Host "Xong. Đặt extra.python_bin: '$P' trong config.yaml" -ForegroundColor Green
