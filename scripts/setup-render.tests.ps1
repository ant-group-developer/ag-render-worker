# Test các hàm của deploy\setup-render.ps1 (không cần quyền admin, không cài gì):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-render.tests.ps1
# Chạy thật trên máy (tạo venv, cài yt-dlp; không cài torch) vào một thư mục tạm:
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\setup-render.ps1 -InstallDir $env:TEMP\ag-setup-test -SkipGpu
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here '..\deploy\setup-render.ps1'

# Cú pháp: lỗi chỉ lộ ra trên máy worker lúc cập nhật
foreach ($f in @($script, (Join-Path $here '..\deploy\setup-python.ps1'))) {
  $tokens = $null; $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f), [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) { throw "$f co loi cu phap: $($errors[0].Message) (dong $($errors[0].Extent.StartLineNumber))" }
}

. $script -DefineOnly

$failures = 0
function Assert-Equal($Name, $Actual, $Expected) {
  if ("$Actual" -ne "$Expected") { Write-Host "FAIL $Name`n  expected: $Expected`n  actual:   $Actual" -ForegroundColor Red; $script:failures++ }
  else { Write-Host "ok   $Name" }
}

$req = "omnivoice>=0.2.1,<0.3`r`nwhisperx>=3.7.4,<4`r`n"
$a = Get-AgSetupStamp -RequirementsText $req -TorchVersion '2.8.0' -TorchIndex 'cu126' -PythonVersion '3.11.9'
$b = Get-AgSetupStamp -RequirementsText ($req -replace "`r`n", "`n") -TorchVersion '2.8.0' -TorchIndex 'cu126' -PythonVersion '3.11.9'
Assert-Equal 'stamp ignores CRLF vs LF' $a $b
Assert-Equal 'stamp is a sha256 hex' $a.Length 64
$c = Get-AgSetupStamp -RequirementsText $req -TorchVersion '2.9.0' -TorchIndex 'cu126' -PythonVersion '3.11.9'
Assert-Equal 'new torch changes the stamp' ($a -eq $c) $false
$d = Get-AgSetupStamp -RequirementsText ($req + 'numpy<3') -TorchVersion '2.8.0' -TorchIndex 'cu126' -PythonVersion '3.11.9'
Assert-Equal 'new requirement changes the stamp' ($a -eq $d) $false
$e = Get-AgSetupStamp -RequirementsText $req -TorchVersion '2.8.0' -TorchIndex 'cu126' -PythonVersion '3.11.10'
Assert-Equal 'new Python changes the stamp' ($a -eq $e) $false

$check = Read-AgCheckJson @('Downloading...', '{"torch": "2.8.0+cu126", "cuda": true, "models": []}', '')
Assert-Equal 'check json: torch' $check.torch '2.8.0+cu126'
Assert-Equal 'check json: cuda' $check.cuda $true
Assert-Equal 'check json: none' (Read-AgCheckJson @('Traceback', 'ImportError')) ''

$script:AgLogFile = Join-Path $env:TEMP "ag-setup-test-$PID.log"
$out = Invoke-AgLogged -Name 'echo' -FilePath 'cmd.exe' -Arguments @('/c', 'echo hello & echo warn 1>&2')
Assert-Equal 'logged command returns its output' (($out | ForEach-Object { "$_".Trim() }) -join ',') 'hello,warn'
$threw = $false
try { Invoke-AgLogged -Name 'fails' -FilePath 'cmd.exe' -Arguments @('/c', 'echo boom & exit 3') | Out-Null } catch { $threw = $_.Exception.Message }
Assert-Equal 'non-zero exit throws with the code' ($threw -match 'ma thoat 3') $true
Assert-Equal 'output goes to the log' ((Get-Content -Raw $script:AgLogFile) -match 'boom') $true
Remove-Item -Force -LiteralPath $script:AgLogFile

Assert-Equal 'missing python has no version' (Get-AgPythonVersion 'C:\nope\python.exe') ''

if ($failures -gt 0) { Write-Host "$failures test loi" -ForegroundColor Red; exit 1 }
Write-Host 'Tat ca test setup-render.ps1 deu qua' -ForegroundColor Green
