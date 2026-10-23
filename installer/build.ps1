# Build FatFish-Setup.exe on Windows + Inno Setup 6
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "== assemble =="
& "$Root\packaging\assemble.ps1"

$candidates = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
  "D:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "D:\Program Files\Inno Setup 6\ISCC.exe"
)
if ($env:INNO_ISCC) { $candidates = @($env:INNO_ISCC) + $candidates }

$ISCC = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $ISCC) {
  Write-Error "ISCC.exe not found. Install Inno Setup 6, or set INNO_ISCC to ISCC.exe full path."
}

Write-Host "== compile $ISCC =="
& $ISCC "$Root\installer\FatFish.iss"
Write-Host "Output: $Root\installer\Output\FatFish-Setup.exe"
