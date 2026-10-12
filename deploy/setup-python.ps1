# Cũ, giữ cho lệnh đã ghi ở đâu đó: nay mọi thứ nằm trong setup-render.ps1 (Python 3.11 tự cài, venv, torch CUDA,
# OmniVoice, WhisperX, yt-dlp, model). install.ps1 của farm tự chạy setup-render.ps1 lúc cài và lúc cập nhật.
#   powershell -ExecutionPolicy Bypass -File deploy\setup-python.ps1 [-Venv C:\ag-farm\venv]
# venv luôn là <thư mục cha của -Venv>\venv; extra.python_bin = <đó>\Scripts\python.exe.
param(
  [string]$Venv = 'C:\ag-farm\venv',
  # Bỏ qua (setup-render.ps1 tự tìm hoặc tự cài Python 3.11)
  [string]$Python = 'py'
)
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup-render.ps1') -InstallDir (Split-Path -Parent $Venv)
exit $LASTEXITCODE
