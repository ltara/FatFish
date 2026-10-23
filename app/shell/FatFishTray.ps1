# DEPRECATED: Prefer the Electron desktop app (app/electron-ui) as the official entry.
# This tray script opens settings/login in the system browser and is kept only as a fallback.
# Do not ship as the primary Start Menu entry once FatFish.exe (Electron) is packaged.
# FatFish system tray (WinForms NotifyIcon)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $Root "scripts\start.ps1"))) {
  $Root = Split-Path -Parent $PSScriptRoot
  if (-not (Test-Path (Join-Path $Root "scripts\start.ps1"))) {
    $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  }
}

$Scripts = Join-Path $Root "scripts"
$AppData = Join-Path $env:APPDATA "FatFish"
$ConfigPath = Join-Path $AppData "config.json"

function Get-FatFishConfig {
  $cfg = @{ settings_port = 8787; login_ui_port = 6099 }
  if (Test-Path $ConfigPath) {
    try {
      $j = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.settings_port) { $cfg.settings_port = [int]$j.settings_port }
      if ($j.login_ui_port) { $cfg.login_ui_port = [int]$j.login_ui_port }
    } catch {}
  }
  return $cfg
}

function Invoke-Script([string]$Name) {
  $p = Join-Path $Scripts $Name
  if (-not (Test-Path $p)) {
    [System.Windows.Forms.MessageBox]::Show("Script not found: $Name", "FatFish") | Out-Null
    return
  }
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $p
  ) -WindowStyle Normal
}

$app = New-Object System.Windows.Forms.ApplicationContext
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = "FatFish"
$notify.Visible = $true
$notify.Icon = [System.Drawing.SystemIcons]::Application

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStart = $menu.Items.Add("Start")
$miStop = $menu.Items.Add("Stop")
$miSettings = $menu.Items.Add("Settings")
$miLogin = $menu.Items.Add("Login")
$miDoctor = $menu.Items.Add("Doctor")
[void]$menu.Items.Add("-")
$miExit = $menu.Items.Add("Exit")
$notify.ContextMenuStrip = $menu

$miStart.add_Click({ Invoke-Script "start.ps1" })
$miStop.add_Click({ Invoke-Script "stop.ps1" })
$miDoctor.add_Click({ Invoke-Script "doctor.ps1" })
$miSettings.add_Click({
  $c = Get-FatFishConfig
  Start-Process "http://127.0.0.1:$($c.settings_port)/settings.html"
})
$miLogin.add_Click({
  $c = Get-FatFishConfig
  Start-Process "http://127.0.0.1:$($c.login_ui_port)/webui/"
})
$miExit.add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify.Add_DoubleClick({
  $c = Get-FatFishConfig
  Start-Process "http://127.0.0.1:$($c.settings_port)/settings.html"
})

# Auto-start services once
Invoke-Script "start.ps1"
[System.Windows.Forms.Application]::Run($app)
