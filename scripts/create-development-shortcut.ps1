param([string]$DataRoot, [switch]$Force)

# Create a local shortcut only; do not start the app, sign licenses or modify app data.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$Launcher = Join-Path $PSScriptRoot "launch-development.ps1"
$Link = Join-Path $Root "肥鱼（开发版）.lnk"
$Electron = Join-Path $Root "app\electron-ui\node_modules\electron\dist\electron.exe"
$Icon = Join-Path $Root "app\electron-ui\assets\icon.ico"
foreach ($File in @($Target, $Launcher, $Electron, $Icon, (Join-Path $Root "vendor\node\node.exe"))) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "创建快捷方式前，请先准备开发运行组件和依赖。" }
}
if ((Test-Path -LiteralPath $Link) -and -not $Force) { throw "快捷方式已存在。请核对后显式使用 -Force 更新，不会自行覆盖。" }
$Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Launcher + '"'
if ($DataRoot) {
  if (-not [System.IO.Path]::IsPathRooted($DataRoot)) { throw "开发数据目录必须是绝对路径。" }
  $DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $DataRoot "config.json") -PathType Leaf)) { throw "指定的原开发配置不存在；未创建快捷方式。" }
  $Arguments += ' -DataRoot "' + $DataRoot + '"'
}
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($Link)
$Shortcut.TargetPath = $Target
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = $Root
$Shortcut.WindowStyle = 7
$Shortcut.IconLocation = $Icon + ",0"
$Shortcut.Description = "肥鱼开发版：源码运行，使用固定开发激活码，不安装、不自动测试模型。"
$Shortcut.Save()
Write-Output $Link
