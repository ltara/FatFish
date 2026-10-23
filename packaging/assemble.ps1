# Assemble dist\FatFish\ install tree for Inno Setup
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root "dist\FatFish"

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path @(
  "$Out\bin\napcat",
  "$Out\bin\node",
  "$Out\app\bridge",
  "$Out\app\shell",
  "$Out\app\web",
  "$Out\scripts",
  "$Out\docs"
) | Out-Null

# Launcher → tray
# Explicit CRLF — Set-Content alone is not enough on all hosts
$bat = "@echo off`r`ncd /d `"%~dp0`"`r`nstart `"`" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"%~dp0app\shell\FatFishTray.ps1`"`r`n"
[System.IO.File]::WriteAllText("$Out\FatFish.bat", $bat, [System.Text.Encoding]::ASCII)

# Optional: also ship a .cmd alias
Copy-Item "$Out\FatFish.bat" "$Out\FatFish.cmd" -Force

Copy-Item "$Root\scripts\*.ps1" "$Out\scripts\" -Force
Copy-Item "$Root\docs\用户说明书.md" "$Out\docs\" -Force
Copy-Item "$Root\app\web\*" "$Out\app\web\" -Recurse -Force
Copy-Item "$Root\app\shell\FatFishTray.ps1" "$Out\app\shell\" -Force
Copy-Item "$Root\app\shell\local-server.mjs" "$Out\app\shell\" -Force
Copy-Item "$Root\app\shell\package.json" "$Out\app\shell\" -Force -ErrorAction SilentlyContinue

# Bridge (include node_modules if present)
Copy-Item "$Root\app\bridge\server.mjs" "$Out\app\bridge\" -Force
Copy-Item "$Root\app\bridge\package.json" "$Out\app\bridge\" -Force
Copy-Item "$Root\app\bridge\persona.example.txt" "$Out\app\bridge\" -Force -ErrorAction SilentlyContinue
if (Test-Path "$Root\app\bridge\package-lock.json") {
  Copy-Item "$Root\app\bridge\package-lock.json" "$Out\app\bridge\" -Force
}
if (Test-Path "$Root\app\bridge\node_modules") {
  Copy-Item "$Root\app\bridge\node_modules" "$Out\app\bridge\node_modules" -Recurse -Force
} else {
  Write-Warning "app\bridge\node_modules missing — run npm install in app\bridge before assemble"
}

# Vendor → bin
if (Test-Path "$Root\vendor\napcat\launcher-user.bat") {
  Write-Host "Copy vendor\napcat → bin\napcat"
  Copy-Item "$Root\vendor\napcat\*" "$Out\bin\napcat\" -Recurse -Force
  & (Join-Path $Root "scripts\ensure-crlf.ps1") (Join-Path $Out "bin\napcat")
} else {
  @"
Place backend service files here (from scripts\fetch-vendor.ps1 → vendor\napcat).
"@ | Set-Content -Encoding UTF8 "$Out\bin\napcat\README.txt"
  Write-Warning "vendor\napcat empty — Setup will lack backend service until fetch-vendor"
}

if (Test-Path "$Root\vendor\node\node.exe") {
  Write-Host "Copy vendor\node → bin\node"
  Copy-Item "$Root\vendor\node\*" "$Out\bin\node\" -Recurse -Force
} else {
  @"
Place portable node.exe here (from fetch-vendor) or rely on system Node.
"@ | Set-Content -Encoding UTF8 "$Out\bin\node\README.txt"
  Write-Warning "vendor\node empty"
}

Copy-Item "$Root\packaging\config.example.json" "$Out\docs\config.example.json" -Force -ErrorAction SilentlyContinue
if (Test-Path "$Root\vendor\MANIFEST.txt") {
  Copy-Item "$Root\vendor\MANIFEST.txt" "$Out\docs\VENDOR_MANIFEST.txt" -Force
}

& (Join-Path $Root "scripts\ensure-crlf.ps1") $Out
Write-Host "Assembled: $Out"
Get-ChildItem $Out -Recurse -File | Measure-Object | ForEach-Object { Write-Host "files=$($_.Count)" }
