# ag-render-worker: cài mọi thứ máy render cần. install.ps1 của farm chạy file này cả lúc cài lẫn lúc cập nhật;
# chạy lại bao nhiêu lần cũng được (bước nào đã xong thì bỏ qua).
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\setup-render.ps1 [-InstallDir C:\ag-farm] [-ResultFile <json>]
#
# Làm:
#   1. Python 3.11: thiếu thì tự cài cho mọi user (winget; không có winget thì bộ cài python.org chạy im lặng)
#   2. venv <InstallDir>\venv (hỏng hoặc không phải 3.11 thì tạo lại)
#   3. yt-dlp trong venv, mỗi lần chạy nâng lên bản mới nhất (YouTube đổi thường xuyên)
#   4. Máy có GPU NVIDIA: torch CUDA + engines\python\requirements.txt (OmniVoice, WhisperX). Dấu
#      <venv>\ag-setup.stamp (hash requirements + bản torch + bản Python) không đổi và import vẫn chạy thì bỏ qua pip.
#   5. Kiểm import torch, omnivoice, whisperx và CUDA; tải trước model (OmniVoice, Whisper large-v3) vào
#      HF_HOME = <InstallDir>\models (worker chạy dưới SYSTEM nên không dùng cache của người cài)
#   6. ffmpeg 8.1 vào <InstallDir>\tools (khoá sha256), encode thử 2 giây (NVENC khi có GPU NVIDIA, không thì libx264);
#      được thì ghi <app>\ffmpeg.json để worker dùng bản này cho render. Hỏng thì worker dùng ffmpeg 6.1 đi kèm như trước
#      (chỉ ghi log và ffmpeg_note, không tính là lỗi). FFMPEG_PATH của máy vẫn thắng.
# Log: <InstallDir>\logs\setup.log. Kết quả cho install.ps1 (JSON): -ResultFile, mặc định <InstallDir>\logs\setup-result.json
#   { "ok": true, "python_bin": "...", "ytdlp_bin": "...", "hf_home": "...", "gpu": true, "torch": "2.8.0+cu126",
#     "cuda": true, "skipped_pip": false, "ffmpeg_bin": "...", "ffmpeg_note": null, "errors": [] }
# Mã thoát 0 khi ok, 1 khi có lỗi (file kết quả vẫn được ghi).
param(
  [string]$InstallDir = 'C:\ag-farm',
  [string]$ResultFile,
  # Không tải trước model (máy mạng chậm: model tải ở job đầu như trước)
  [switch]$SkipModels,
  # Bỏ qua dấu, chạy lại pip
  [switch]$Force,
  # Không cài torch/OmniVoice/WhisperX dù máy có GPU NVIDIA (GPU để việc khác)
  [switch]$SkipGpu,
  # Không cài ffmpeg 8.1 (worker dùng ffmpeg 6.1 đi kèm)
  [switch]$SkipFfmpeg,
  # Chỉ nạp các hàm (test: . .\setup-render.ps1 -DefineOnly)
  [switch]$DefineOnly
)

$AgTorchVersion = '2.8.0'
$AgTorchIndex = 'https://download.pytorch.org/whl/cu126'

# ffmpeg cho render: bản essentials của gyan.dev trên GitHub, sha256 lấy từ digest của asset. ffmpeg 6.1 đi kèm worker
# ngốn ~29 GB RAM ở lượt ghép cuối 4K trên máy 32 GB; 8.1 (đa luồng mới) đo trên AG-189 còn 14-16 GB. 9.x cần driver
# NVIDIA >= 610, driver trên farm chưa đạt.
$AgFfmpegVersion = '8.1'
$AgFfmpegUrl = 'https://github.com/GyanD/codexffmpeg/releases/download/8.1/ffmpeg-8.1-essentials_build.zip'
$AgFfmpegSha256 = '8748283d821613d930b0e7be685aaa9df4ca6f0ad4d0c42fd02622b3623463c6'
# Bản 3.11 cuối cùng python.org còn phát hành bộ cài Windows
$AgPythonInstallerUrl = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe'

function Write-AgLog {
  param([string]$Message)
  $line = "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] $Message"
  Write-Host $line
  if ($script:AgLogFile) { Add-Content -LiteralPath $script:AgLogFile -Value $line -Encoding UTF8 }
}

# Chạy chương trình ngoài, ghi toàn bộ output vào log, ném lỗi khi mã thoát khác 0. Trả về các dòng stdout+stderr.
function Invoke-AgLogged {
  param([string]$Name, [string]$FilePath, [string[]]$Arguments)
  Write-AgLog "$Name"
  # PowerShell 5.1: stderr của chương trình ngoài thành ErrorRecord, với 'Stop' thì dòng cảnh báo đầu tiên của pip
  # cũng ném lỗi. Ở đây chỉ tin mã thoát.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($script:AgLogFile -and $out.Count -gt 0) { Add-Content -LiteralPath $script:AgLogFile -Value $out -Encoding UTF8 }
  if ($code -ne 0) {
    $tail = ($out | Select-Object -Last 3) -join ' | '
    throw "$Name loi (ma thoat $code): $tail"
  }
  return $out
}

# Hash của những gì quyết định nội dung venv GPU: requirements (bỏ khác biệt CRLF/LF), bản torch, nguồn torch, bản Python.
function Get-AgSetupStamp {
  param([string]$RequirementsText, [string]$TorchVersion, [string]$TorchIndex, [string]$PythonVersion)
  $norm = ($RequirementsText -replace "`r`n", "`n").Trim()
  $text = "requirements=$norm`ntorch=$TorchVersion`nindex=$TorchIndex`npython=$PythonVersion"
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) } finally { $sha.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# "3.11" của một python.exe, hoặc $null nếu không chạy được.
function Get-AgPythonVersion {
  param([string]$Python)
  if (-not $Python) { return $null }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $v = & $Python -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ("$v").Trim()
  } catch { return $null } finally { $ErrorActionPreference = $prev }
}

# Đường dẫn python.exe 3.11 của máy (không phải venv), hoặc $null.
function Find-AgPython311 {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $launchers = @()
    $cmd = Get-Command py -ErrorAction SilentlyContinue
    if ($cmd) { $launchers += $cmd.Source }
    if ($env:WINDIR) { $launchers += (Join-Path $env:WINDIR 'py.exe') }
    foreach ($py in $launchers) {
      if (-not (Test-Path -LiteralPath $py)) { continue }
      $exe = & $py -3.11 -c "import sys;print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path -LiteralPath ("$exe").Trim())) { return ("$exe").Trim() }
    }
  } catch { } finally { $ErrorActionPreference = $prev }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Python311\python.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe') }
  foreach ($c in $candidates) {
    if ((Test-Path -LiteralPath $c) -and (Get-AgPythonVersion $c) -eq '3.11') { return $c }
  }
  return $null
}

function Install-AgPython311 {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    try {
      Invoke-AgLogged -Name 'Cai Python 3.11 (winget)' -FilePath $winget.Source -Arguments @(
        'install', '-e', '--id', 'Python.Python.3.11', '--scope', 'machine', '--silent',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
      ) | Out-Null
      return
    } catch {
      Write-AgLog "winget khong cai duoc Python ($($_.Exception.Message)); dung bo cai python.org"
    }
  }
  $setup = Join-Path $env:TEMP 'python-3.11-amd64.exe'
  Write-AgLog "Tai $AgPythonInstallerUrl"
  Invoke-WebRequest -Uri $AgPythonInstallerUrl -OutFile $setup -UseBasicParsing
  $sig = Get-AuthenticodeSignature -LiteralPath $setup
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Python Software Foundation') {
    Remove-Item -Force -LiteralPath $setup -ErrorAction SilentlyContinue
    throw "Bo cai Python tai ve khong co chu ky hop le cua Python Software Foundation ($($sig.Status))"
  }
  Write-AgLog 'Cai Python 3.11 (python.org, cho moi user)'
  $p = Start-Process -FilePath $setup -Wait -PassThru -ArgumentList @(
    '/quiet', 'InstallAllUsers=1', 'PrependPath=0', 'Include_launcher=1', 'InstallLauncherAllUsers=1',
    'Include_test=0', 'Include_doc=0', 'Shortcuts=0'
  )
  Remove-Item -Force -LiteralPath $setup -ErrorAction SilentlyContinue
  # 3010: xong, cần khởi động lại (Python vẫn dùng được ngay)
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Bo cai Python thoat voi ma $($p.ExitCode)" }
}

# Máy có GPU NVIDIA dùng được (driver trả lời nvidia-smi).
function Test-AgNvidiaGpu {
  $paths = @()
  $cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if ($cmd) { $paths += $cmd.Source }
  if ($env:WINDIR) { $paths += (Join-Path $env:WINDIR 'System32\nvidia-smi.exe') }
  if ($env:ProgramFiles) { $paths += (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe') }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    foreach ($smi in $paths) {
      if (-not (Test-Path -LiteralPath $smi)) { continue }
      $names = & $smi --query-gpu=name --format=csv,noheader 2>$null
      if ($LASTEXITCODE -eq 0 -and ("$names").Trim()) { return $true }
    }
  } catch { } finally { $ErrorActionPreference = $prev }
  return $false
}

# ffmpeg.exe của bản $Version trong <InstallDir>\tools: đã có thì dùng lại, không thì tải, kiểm sha256, giải nén.
function Install-AgFfmpeg {
  param([string]$InstallDir, [string]$Version = $AgFfmpegVersion, [string]$Url = $AgFfmpegUrl, [string]$Sha256 = $AgFfmpegSha256)
  $root = Join-Path $InstallDir 'tools'
  $exe = Join-Path $root "ffmpeg-$Version-essentials_build\bin\ffmpeg.exe"
  if (Test-Path -LiteralPath $exe) { return $exe }
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  # Expand-Archive chỉ nhận đuôi .zip
  $zip = Join-Path $root "ffmpeg-$Version-essentials_build.download.zip"
  Write-AgLog "Tai ffmpeg $Version ($Url)"
  try {
    Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    if ($hash -ne $Sha256.ToLowerInvariant()) { throw "sha256 cua goi ffmpeg khong khop ($hash)" }
    Expand-Archive -LiteralPath $zip -DestinationPath $root -Force
  } finally {
    Remove-Item -Force -LiteralPath $zip -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $exe)) { throw "giai nen xong nhung khong thay $exe" }
  return $exe
}

# Encode thử 2 giây: NVENC khi máy có GPU NVIDIA (driver quá cũ cho bản này thì hỏng ở đây), không thì libx264.
function Test-AgFfmpegEncode {
  param([string]$Exe, [bool]$Nvenc)
  $codec = if ($Nvenc) { 'h264_nvenc' } else { 'libx264' }
  Invoke-AgLogged -Name "Thu ffmpeg encode $codec" -FilePath $Exe -Arguments @(
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=2', '-c:v', $codec, '-f', 'null', '-'
  ) | Out-Null
}

# <app>\ffmpeg.json: ffmpeg worker dùng cho render (src/ffmpeg-utils.ts đọc).
function Write-AgFfmpegMarker {
  param([string]$AppDir, [string]$Exe, [string]$Version, [bool]$Nvenc)
  $json = [ordered]@{ ffmpeg = $Exe; version = $Version; nvenc = $Nvenc } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $AppDir 'ffmpeg.json'), $json, (New-Object Text.UTF8Encoding($false)))
}

# Dòng JSON cuối cùng trong output của setup_check.py.
function Read-AgCheckJson {
  param([string[]]$Lines)
  for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
    $l = "$($Lines[$i])".Trim()
    if ($l.StartsWith('{')) { return ($l | ConvertFrom-Json) }
  }
  return $null
}

function Invoke-AgSetupRender {
  param([string]$InstallDir, [string]$ResultFile, [switch]$SkipModels, [switch]$Force, [switch]$SkipGpu, [switch]$SkipFfmpeg)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $appDir = Split-Path -Parent $PSScriptRoot
  $logDir = Join-Path $InstallDir 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $script:AgLogFile = Join-Path $logDir 'setup.log'
  if ((Test-Path -LiteralPath $script:AgLogFile) -and (Get-Item -LiteralPath $script:AgLogFile).Length -gt 5MB) {
    Move-Item -Force -LiteralPath $script:AgLogFile -Destination (Join-Path $logDir 'setup.1.log')
  }
  if (-not $ResultFile) { $ResultFile = Join-Path $logDir 'setup-result.json' }

  $venv = Join-Path $InstallDir 'venv'
  $hfHome = Join-Path $InstallDir 'models'
  New-Item -ItemType Directory -Force -Path $hfHome | Out-Null
  # Cho mọi tiến trình Python chạy từ đây (pip, kiểm tra, tải model)
  $env:HF_HOME = $hfHome
  $env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
  $env:PIP_NO_INPUT = '1'
  $env:PYTHONUTF8 = '1'

  $result = [ordered]@{
    ok = $false; python_bin = $null; ytdlp_bin = $null; hf_home = $hfHome
    gpu = $false; torch = $null; cuda = $false; skipped_pip = $false; ffmpeg_bin = $null; ffmpeg_note = $null; errors = @()
  }
  Write-AgLog "=== setup-render ($appDir) ==="

  # 1-2. Python 3.11 và venv: thiếu là không làm được gì tiếp
  $py = $null
  try {
    $base = Find-AgPython311
    if (-not $base) {
      Install-AgPython311
      $base = Find-AgPython311
      if (-not $base) { throw 'Da cai Python 3.11 nhung khong tim thay python.exe (thu khoi dong lai may roi chay lai lenh cap nhat)' }
    }
    Write-AgLog "Python 3.11: $base"
    $py = Join-Path $venv 'Scripts\python.exe'
    if ((Get-AgPythonVersion $py) -ne '3.11') {
      if (Test-Path -LiteralPath $venv) {
        Write-AgLog "venv $venv hong hoac khong phai Python 3.11: tao lai"
        Remove-Item -Recurse -Force -LiteralPath $venv
      }
      Invoke-AgLogged -Name "Tao venv $venv" -FilePath $base -Arguments @('-m', 'venv', $venv) | Out-Null
    }
    Invoke-AgLogged -Name 'Nang pip' -FilePath $py -Arguments @('-m', 'pip', 'install', '--upgrade', 'pip') | Out-Null
    $result.python_bin = $py
  } catch {
    $result.errors += "python: $($_.Exception.Message)"
    $py = $null
  }

  if ($py) {
    # 3. yt-dlp: mọi máy render, luôn bản mới nhất
    try {
      Invoke-AgLogged -Name 'Cai/nang yt-dlp' -FilePath $py -Arguments @('-m', 'pip', 'install', '--upgrade', 'yt-dlp[default]') | Out-Null
      $ytdlp = Join-Path $venv 'Scripts\yt-dlp.exe'
      $v = Invoke-AgLogged -Name 'Kiem yt-dlp' -FilePath $ytdlp -Arguments @('--version')
      Write-AgLog "yt-dlp $(($v | Select-Object -Last 1))"
      $result.ytdlp_bin = $ytdlp
    } catch {
      $result.errors += "yt-dlp: $($_.Exception.Message)"
    }

    # 4-5. GPU: torch CUDA, OmniVoice, WhisperX, model
    $result.gpu = (-not $SkipGpu) -and (Test-AgNvidiaGpu)
    if ($result.gpu) {
      try {
        $reqPath = Join-Path $appDir 'engines\python\requirements.txt'
        $checkPy = Join-Path $appDir 'engines\python\setup_check.py'
        $stampPath = Join-Path $venv 'ag-setup.stamp'
        $pyFull = (Invoke-AgLogged -Name 'Ban Python cua venv' -FilePath $py -Arguments @('-c', 'import platform;print(platform.python_version())') | Select-Object -Last 1)
        $stamp = Get-AgSetupStamp -RequirementsText (Get-Content -Raw -Encoding UTF8 -LiteralPath $reqPath) `
          -TorchVersion $AgTorchVersion -TorchIndex $AgTorchIndex -PythonVersion "$pyFull".Trim()
        $oldStamp = $null
        if (Test-Path -LiteralPath $stampPath) { $oldStamp = (Get-Content -Raw -LiteralPath $stampPath).Trim() }

        $check = $null
        if (-not $Force -and $oldStamp -eq $stamp) {
          # Dấu khớp: chỉ kiểm import; hỏng (ai đó gỡ gói) thì cài lại như dấu không khớp
          try {
            $check = Read-AgCheckJson (Invoke-AgLogged -Name 'Kiem venv (khong doi gi: bo qua pip)' -FilePath $py -Arguments @($checkPy))
            $result.skipped_pip = $true
          } catch {
            Write-AgLog "venv khong con dung duoc ($($_.Exception.Message)): cai lai"
            $check = $null
          }
        }
        if (-not $check) {
          Remove-Item -Force -LiteralPath $stampPath -ErrorAction SilentlyContinue
          # torch bản CUDA trước, từ index của PyTorch, để requirements không kéo bản chỉ có CPU
          Invoke-AgLogged -Name "Cai torch $AgTorchVersion (CUDA)" -FilePath $py -Arguments @(
            '-m', 'pip', 'install', "torch==$AgTorchVersion", "torchaudio==$AgTorchVersion", '--index-url', $AgTorchIndex
          ) | Out-Null
          Invoke-AgLogged -Name 'Cai OmniVoice, WhisperX (requirements.txt)' -FilePath $py -Arguments @('-m', 'pip', 'install', '-r', $reqPath) | Out-Null
          $check = Read-AgCheckJson (Invoke-AgLogged -Name 'Kiem import torch, omnivoice, whisperx' -FilePath $py -Arguments @($checkPy))
          if (-not $check) { throw 'setup_check.py khong in ket qua' }
          [IO.File]::WriteAllText($stampPath, $stamp, (New-Object Text.UTF8Encoding($false)))
        }
        $result.torch = $check.torch
        $result.cuda = [bool]$check.cuda
        Write-AgLog "torch $($check.torch), CUDA: $($check.cuda)"
        if (-not $result.cuda) {
          $result.errors += 'cuda: torch khong thay GPU (driver NVIDIA qua cu?). TTS/nhan dang loi noi se chay tren CPU rat cham'
        } elseif (-not $SkipModels) {
          Invoke-AgLogged -Name "Tai truoc model vao $hfHome (lan dau vai GB)" -FilePath $py -Arguments @($checkPy, '--models') | Out-Null
        }
      } catch {
        $result.errors += "gpu: $($_.Exception.Message)"
      }
    } else {
      Write-AgLog 'Khong co GPU NVIDIA (hoac -SkipGpu): bo qua torch/OmniVoice/WhisperX (may nay khong nhan studio.tts, studio.transcribe)'
    }
  }

  # 6. ffmpeg 8.1 cho render; hỏng thì worker dùng 6.1 đi kèm (không tính là lỗi cài)
  Remove-Item -Force -LiteralPath (Join-Path $appDir 'ffmpeg.json') -ErrorAction SilentlyContinue
  if ($SkipFfmpeg) {
    $result.ffmpeg_note = 'bo qua (-SkipFfmpeg): worker dung ffmpeg 6.1 di kem'
  } else {
    try {
      $exe = Install-AgFfmpeg -InstallDir $InstallDir
      $nvenc = (-not $SkipGpu) -and (Test-AgNvidiaGpu)
      Test-AgFfmpegEncode -Exe $exe -Nvenc $nvenc
      Write-AgFfmpegMarker -AppDir $appDir -Exe $exe -Version $AgFfmpegVersion -Nvenc $nvenc
      $result.ffmpeg_bin = $exe
      Write-AgLog "ffmpeg $AgFfmpegVersion cho render: $exe"
    } catch {
      $result.ffmpeg_note = "ffmpeg $($AgFfmpegVersion): $($_.Exception.Message); worker dung ffmpeg 6.1 di kem"
      Write-AgLog $result.ffmpeg_note
    }
  }

  $result.ok = ($result.errors.Count -eq 0)
  foreach ($e in $result.errors) { Write-AgLog "LOI $e" }
  Write-AgLog "=== setup-render xong: ok=$($result.ok) ==="
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResultFile) | Out-Null
  [IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
  return $result
}

if ($DefineOnly) { return }
$r = Invoke-AgSetupRender -InstallDir $InstallDir -ResultFile $ResultFile -SkipModels:$SkipModels -Force:$Force -SkipGpu:$SkipGpu -SkipFfmpeg:$SkipFfmpeg
if ($r.ok) { exit 0 } else { exit 1 }
