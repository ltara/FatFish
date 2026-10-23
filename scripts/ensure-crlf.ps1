# Force CRLF on *.bat / *.cmd under given directories (default: vendor\napcat, dist\FatFish)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Targets = if ($args.Count -gt 0) { $args } else {
  @(
    (Join-Path $Root "vendor\napcat"),
    (Join-Path $Root "dist\FatFish")
  )
}
$fixed = 0
foreach ($t in $Targets) {
  if (-not (Test-Path $t)) { continue }
  Get-ChildItem -Path $t -Recurse -File -Include *.bat,*.cmd | ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    # Also try system ANSI-safe: work on bytes
    $norm = New-Object System.Collections.Generic.List[byte]
    $i = 0
    while ($i -lt $bytes.Length) {
      $b = $bytes[$i]
      if ($b -eq 0x0D) {
        if (($i + 1) -lt $bytes.Length -and $bytes[$i+1] -eq 0x0A) {
          [void]$norm.Add(0x0D); [void]$norm.Add(0x0A); $i += 2; continue
        }
        [void]$norm.Add(0x0D); [void]$norm.Add(0x0A); $i += 1; continue
      }
      if ($b -eq 0x0A) {
        [void]$norm.Add(0x0D); [void]$norm.Add(0x0A); $i += 1; continue
      }
      [void]$norm.Add($b); $i += 1
    }
    $out = $norm.ToArray()
    $same = ($out.Length -eq $bytes.Length)
    if ($same) {
      for ($j = 0; $j -lt $out.Length; $j++) { if ($out[$j] -ne $bytes[$j]) { $same = $false; break } }
    }
    if (-not $same) {
      [System.IO.File]::WriteAllBytes($_.FullName, $out)
      Write-Host "[crlf] fixed $($_.FullName)"
      $fixed++
    }
  }
}
Write-Host "[crlf] done, fixed=$fixed"
