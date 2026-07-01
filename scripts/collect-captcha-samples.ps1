param(
  [int]$Count = 30,
  [string]$OutDir = "",
  [int]$Columns = 5,
  [int]$Scale = 4
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) "data\captcha-samples\$stamp"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$cookie = Join-Path $OutDir 'cookies.txt'
$loginHtml = Join-Path $OutDir 'login.html'

curl.exe -L -s -c $cookie -b $cookie 'https://authserver.nju.edu.cn/authserver/login' -o $loginHtml

for ($i = 1; $i -le $Count; $i++) {
  $name = '{0:D2}.png' -f $i
  $path = Join-Path $OutDir $name
  $stampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $i
  $url = "https://authserver.nju.edu.cn/authserver/getCaptcha.htl?$stampMs"
  curl.exe -L -s -c $cookie -b $cookie $url -o $path
  Start-Sleep -Milliseconds 80
}

$files = Get-ChildItem $OutDir -Filter '*.png' | Sort-Object Name
$answersCsv = Join-Path $OutDir 'answers.csv'
@('id,file,answer') + ($files | ForEach-Object {
  $id = [IO.Path]::GetFileNameWithoutExtension($_.Name)
  "$id,$($_.Name),"
}) | Set-Content -Path $answersCsv -Encoding UTF8

Add-Type -AssemblyName System.Drawing
$pad = 18
$labelH = 28
$thumbW = 120 * $Scale
$thumbH = 40 * $Scale
$cellW = $thumbW + $pad * 2
$cellH = $thumbH + $labelH + $pad * 2
$rows = [Math]::Ceiling($files.Count / $Columns)
$sheetPath = Join-Path $OutDir 'contact-sheet.png'

$bmp = New-Object Drawing.Bitmap ($Columns * $cellW),($rows * $cellH)
$g = [Drawing.Graphics]::FromImage($bmp)
$g.Clear([Drawing.Color]::White)
$g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$font = New-Object Drawing.Font('Arial',16,[Drawing.FontStyle]::Bold)
$brush = [Drawing.Brushes]::Black

for ($i = 0; $i -lt $files.Count; $i++) {
  $img = [Drawing.Image]::FromFile($files[$i].FullName)
  $col = $i % $Columns
  $row = [Math]::Floor($i / $Columns)
  $x = $col * $cellW + $pad
  $y = $row * $cellH + $pad
  $id = [IO.Path]::GetFileNameWithoutExtension($files[$i].Name)
  $g.DrawString($id, $font, $brush, $x, $y)
  $g.DrawImage($img, $x, $y + $labelH, $thumbW, $thumbH)
  $img.Dispose()
}

$g.Dispose()
$bmp.Save($sheetPath, [Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "Created sample set: $OutDir"
Write-Host "Contact sheet: $sheetPath"
Write-Host "Answer sheet: $answersCsv"

