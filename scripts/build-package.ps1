$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$version = $manifest.version

$dist = Join-Path $root 'dist'
$staging = Join-Path $dist 'extension'
$verify = Join-Path $dist 'verify'
$zipPath = Join-Path $dist "NJU-Login-Pro-v$version.zip"

Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $verify -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$files = @(
  'manifest.json',
  'content.js',
  'content-grab.js',
  'popup.html',
  'popup.js',
  'tesseract.min.js',
  'icon16.png',
  'icon48.png',
  'icon128.png'
)

$dirs = @(
  '_locales',
  'langs'
)

foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $staging $file)
}

foreach ($dir in $dirs) {
  Copy-Item -LiteralPath (Join-Path $root $dir) -Destination (Join-Path $staging $dir) -Recurse
}

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force

Expand-Archive -Path $zipPath -DestinationPath $verify -Force
if (-not (Test-Path (Join-Path $verify 'manifest.json'))) {
  throw 'Package verification failed: manifest.json is not at the zip root.'
}

Remove-Item -LiteralPath $staging -Recurse -Force
Remove-Item -LiteralPath $verify -Recurse -Force

$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "Created $zipPath ($sizeMb MB)"
