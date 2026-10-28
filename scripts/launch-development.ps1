param([string]$DataRoot)

# User-invoked shortcut target only. Never run this during automatic verification.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Result = 1
try {
  $Node = Join-Path $Root "vendor\node\node.exe"
  $Launcher = Join-Path $Root "app\electron-ui\scripts\run-development-client.cjs"
  $Electron = Join-Path $Root "app\electron-ui\node_modules\electron\dist\electron.exe"
  foreach ($File in @($Node, $Launcher, $Electron)) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "开发运行组件或依赖缺失。" }
  }
  $Arguments = '"' + $Launcher + '"'
  if ($DataRoot) {
    if (-not [System.IO.Path]::IsPathRooted($DataRoot) -or -not (Test-Path -LiteralPath (Join-Path $DataRoot "config.json") -PathType Leaf)) {
      throw "快捷方式指定的原开发数据目录已不存在；不会自动换目录或删除配置。"
    }
    $Arguments += ' --data-root "' + $DataRoot + '"'
  }
  # The helper stays hidden; the app window is opened only after the user double-clicks.
  # Do not capture app stdout/stderr into extra persistent files.
  $Child = Start-Process -FilePath $Node -ArgumentList $Arguments -WorkingDirectory (Join-Path $Root "app\electron-ui") -WindowStyle Hidden -PassThru -Wait
  if ($null -ne $Child.ExitCode) { $Result = [int]$Child.ExitCode }
  if ($Result -ne 0) {
    throw "开发启动未完成。请检查开发依赖、数据目录和已有开发许可证；不要删除数据或激活服务密钥。排查说明：docs\DEVELOPMENT_ACTIVATION.md。"
  }
} catch {
  $Message = "肥鱼开发版未能正常启动或退出。`r`n`r`n" + $_.Exception.Message
  $Shell = New-Object -ComObject WScript.Shell
  $null = $Shell.Popup($Message, 0, "肥鱼 · 开发版", 16)
}
exit $Result
