param(
  [switch]$Dev
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$version = $manifest.version

$dist = Join-Path $root 'dist'
$staging = Join-Path $dist 'extension'
$verify = Join-Path $dist 'verify'
$packageName = if ($Dev) { "NJU-Login-Pro-dev-v$version.zip" } else { "NJU-Login-Pro-v$version.zip" }
$zipPath = Join-Path $dist $packageName

Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $verify -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$files = @(
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'manifest.json',
  'auth-slider-captcha.js',
  'auth-background-login.js',
  'auth-login-fast.js',
  'auth-session-prewarm.js',
  'auth-prewarm-bridge.js',
  'captcha-cnn.js',
  'content.js',
  'grab-task-model.js',
  'grab-auth-presentation.js',
  'grab-verification-engine.js',
  'grab-engine.js',
  'grab-course-provider.js',
  'grab-network-bridge.js',
  'grab-task-session.js',
  'grab-login-shield.js',
  'content-grab.js',
  'grab-page-ui.css',
  'click-captcha-worker.js',
  'popup.html',
  'popup.js',
  'tesseract.min.js',
  'tesseract.min.js.LICENSE.txt',
  'icon16.png',
  'icon48.png',
  'icon128.png',
  'assets/captcha-template-model.json',
  'assets/captcha-cnn-model.json',
  'assets/captcha-cnn-model.bin',
  'assets/click-captcha-model.onnx',
  'assets/click-captcha-background.png'
)

$dirs = @(
  '_locales',
  'langs',
  'vendor'
)

foreach ($file in $files) {
  $source = Join-Path $root $file
  $destination = Join-Path $staging $file
  $destinationDir = Split-Path -Parent $destination
  if (-not (Test-Path -LiteralPath $destinationDir)) {
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
  }
  Copy-Item -LiteralPath $source -Destination $destination
}

foreach ($dir in $dirs) {
  Copy-Item -LiteralPath (Join-Path $root $dir) -Destination (Join-Path $staging $dir) -Recurse
}

if (-not $Dev) {
  # 开发采样面板只存在于源码/开发包；正式发布包保留运行时兼容代码，但不暴露入口。
  $popupPath = Join-Path $staging 'popup.html'
  $popupHtml = Get-Content -Raw -LiteralPath $popupPath
  $popupHtml = $popupHtml.Replace('data-build="dev"', 'data-build="release"')
  [System.IO.File]::WriteAllText($popupPath, $popupHtml, [System.Text.UTF8Encoding]::new($false))
}

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force

Expand-Archive -Path $zipPath -DestinationPath $verify -Force
if (-not (Test-Path (Join-Path $verify 'manifest.json'))) {
  throw 'Package verification failed: manifest.json is not at the zip root.'
}

$packageManifest = Get-Content -Raw -LiteralPath (Join-Path $verify 'manifest.json') | ConvertFrom-Json
if ($packageManifest.permissions -contains 'unlimitedStorage') {
  throw 'Package verification failed: release packages must not request unlimitedStorage.'
}

$releasePopup = Get-Content -Raw -LiteralPath (Join-Path $verify 'popup.html')
if (($releasePopup -notmatch 'data-build="release"') -or ($releasePopup -notmatch 'body\[data-build="release"\] \[data-dev-only\]')) {
  throw 'Package verification failed: release build must hide development-only tools.'
}

if (-not (Test-Path (Join-Path $verify 'assets/captcha-template-model.json'))) {
  throw 'Package verification failed: captcha template model is missing.'
}

if ((-not (Test-Path (Join-Path $verify 'LICENSE'))) -or
    (-not (Test-Path (Join-Path $verify 'THIRD_PARTY_NOTICES.md'))) -or
    (-not (Test-Path (Join-Path $verify 'tesseract.min.js.LICENSE.txt')))) {
  throw 'Package verification failed: project or third-party license notices are missing.'
}

if ((-not (Test-Path (Join-Path $verify 'captcha-cnn.js'))) -or
    (-not (Test-Path (Join-Path $verify 'assets/captcha-cnn-model.json'))) -or
    (-not (Test-Path (Join-Path $verify 'assets/captcha-cnn-model.bin')))) {
  throw 'Package verification failed: captcha CNN runtime or model is missing.'
}

if (-not (Test-Path (Join-Path $verify 'auth-slider-captcha.js'))) {
  throw 'Package verification failed: auth slider captcha runtime is missing.'
}

if ((-not (Test-Path (Join-Path $verify 'auth-background-login.js'))) -or
    (-not (Test-Path (Join-Path $verify 'auth-session-prewarm.js'))) -or
    (-not (Test-Path (Join-Path $verify 'auth-prewarm-bridge.js')))) {
  throw 'Package verification failed: auth session prewarm runtime is missing.'
}

if ((-not (Test-Path (Join-Path $verify 'grab-task-model.js'))) -or
    (-not (Test-Path (Join-Path $verify 'grab-auth-presentation.js'))) -or
    (-not (Test-Path (Join-Path $verify 'grab-verification-engine.js'))) -or
    (-not (Test-Path (Join-Path $verify 'grab-engine.js'))) -or
    (-not (Test-Path (Join-Path $verify 'grab-course-provider.js'))) -or
    (-not (Test-Path (Join-Path $verify 'grab-network-bridge.js'))) -or
    (-not (Test-Path (Join-Path $verify 'grab-task-session.js'))) -or
    (-not (Test-Path (Join-Path $verify 'grab-login-shield.js'))) -or
    (-not (Test-Path (Join-Path $verify 'content-grab.js'))) -or
    (-not (Test-Path (Join-Path $verify 'grab-page-ui.css')))) {
  throw 'Package verification failed: course grab runtime is missing.'
}

if ((-not (Test-Path (Join-Path $verify 'click-captcha-worker.js'))) -or
    (-not (Test-Path (Join-Path $verify 'assets/click-captcha-model.onnx'))) -or
    (-not (Test-Path (Join-Path $verify 'assets/click-captcha-background.png'))) -or
    (-not (Test-Path (Join-Path $verify 'vendor/onnxruntime/ort.wasm.bundle.min.js'))) -or
    (-not (Test-Path (Join-Path $verify 'vendor/onnxruntime/ort-wasm-simd-threaded.wasm')))) {
  throw 'Package verification failed: click-captcha runtime or model is missing.'
}

Remove-Item -LiteralPath $staging -Recurse -Force
Remove-Item -LiteralPath $verify -Recurse -Force

$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "Created $zipPath ($sizeMb MB)"
