# ============================================================
#  Personal Assistant (Taro H5) one-click deploy script  (Win/PowerShell)
#  Uploads local dist/ static output to your cloud server docroot.
#
#  Usage:
#    1) Copy .deploy-config.example.json -> .deploy-config.json, fill it in.
#    2) Run (re-deploy / just upload / dry-run):
#       .\deploy.ps1 -Build        # rebuild H5 first
#       .\deploy.ps1               # upload only (full replace of remote dir)
#       .\deploy.ps1 -DryRun       # only print commands, do not execute
# ============================================================

[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Root '.deploy-config.json'

if (-not (Test-Path $ConfigPath)) {
  Write-Host '[ERROR] config file not found: ' -ForegroundColor Red -NoNewline
  Write-Host $ConfigPath -ForegroundColor Red
  Write-Host 'Copy .deploy-config.example.json to .deploy-config.json and fill your server info.' -ForegroundColor Yellow
  exit 1
}

$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -ne $cfg -and -not $cfg.host) {
  Write-Host '[ERROR] .deploy-config.json still contains placeholder values (host/user/remoteDir).' -ForegroundColor Red
  exit 1
}

# ---------- 1. optional rebuild ----------
$dist = Join-Path $Root 'dist'
if ($Build) {
  Write-Host '==> Rebuilding H5 output (taro build --type h5) ...' -ForegroundColor Green
  Push-Location $Root
  npm run build:h5
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { exit $code }
}

if (-not (Test-Path (Join-Path $dist 'index.html'))) {
  Write-Host "[ERROR] $dist\index.html not found. Run .\deploy.ps1 -Build first." -ForegroundColor Red
  exit 1
}

# ---------- 1.5 发布前预检：不通过就拒绝打包 ----------
# 2026-11-03：实测出现过只跑 `taro build`、漏 copy-assets 的半成品 dist
# （缺 assets/wb-sdk.js → 线上 SDK 404、登录/同步/AI 全废）。打包前必须先过闸。
Write-Host '==> Verify deploy freshness (dist) ...' -ForegroundColor Green
Push-Location $Root
& node .tools/verify-deploy-fresh.mjs dist
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) {
  Write-Host '[ERROR] dist 未通过发布前预检（缺 build-stamp / assets/wb-sdk.js / 热点数据等），拒绝打包。' -ForegroundColor Red
  Write-Host '        请先完整执行 npm run build:h5（taro build + copy-assets + fetch-data）。' -ForegroundColor Yellow
  exit $code
}

$tar = Join-Path $env:TEMP 'dist-deploy.tar.gz'
Write-Host "==> Packing dist -> $tar" -ForegroundColor Green

if (Get-Command tar -ErrorAction SilentlyContinue) {
  Push-Location $Root
  & tar -czf $tar -C dist .
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { exit $code }
} else {
  Write-Host '[ERROR] tar command not found on this system.' -ForegroundColor Red
  exit 1
}

$authPart = ''
if ($cfg.authType -eq 'key' -and $cfg.keyPath) {
  $authPart = "-i `"$($cfg.keyPath)`""
}
# Use ${target}: so the colon is not swallowed into the variable name
$target = "$($cfg.user)@$($cfg.host)"

Write-Host '==> Uploading archive to /tmp/dist-deploy.tar.gz ...' -ForegroundColor Green
if (-not $DryRun) {
  $scpUp = "-P $($cfg.port) $authPart `"$tar`" ${target}:/tmp/dist-deploy.tar.gz"
  & scp -r $scpUp
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host '[DryRun] scp -r -P <port> <auth> <tar> <target>:/tmp/dist-deploy.tar.gz'
}

# ---------- 2. extract on remote (replace docroot) ----------
if ($DryRun) {
  Write-Host '[DryRun] ssh -p <port> <auth> <target> "rm -rf <remoteDir>/* && mkdir -p <remoteDir> && tar -xzf /tmp/dist-deploy.tar.gz -C <remoteDir> && rm -f /tmp/dist-deploy.tar.gz && echo DEPLOY_OK"'
  Remove-Item $tar -ErrorAction SilentlyContinue
  Write-Host '[DryRun] done. Nothing executed.' -ForegroundColor Cyan
  exit 0
}

$sshAuth = ''
if ($cfg.authType -eq 'key' -and $cfg.keyPath) {
  $sshAuth = "-i `"$($cfg.keyPath)`""
}
$r = [string]$cfg.remoteDir
$steps = @(
  "rm -rf `"$r`"/*",
  "mkdir -p `"$r`"",
  "tar -xzf /tmp/dist-deploy.tar.gz -C `"$r`"",
  'rm -f /tmp/dist-deploy.tar.gz',
  'echo DEPLOY_OK'
)
# Build '&&' at runtime to avoid the old-PowerShell parser rejecting '&&' in source.
$cmd = $steps -join ' && '

Write-Host "==> Extracting to `"$r`" ..." -ForegroundColor Green
& ssh -p $cfg.port ${sshAuth} $target "`"$cmd`""
if ($LASTEXITCODE -ne 0) {
  Write-Host '[ERROR] remote deploy failed.' -ForegroundColor Red
  exit $LASTEXITCODE
}

Remove-Item $tar -ErrorAction SilentlyContinue
Write-Host '' -ForegroundColor Green
Write-Host 'Deploy done!' -ForegroundColor Green
Write-Host ('Public URL: ' + $cfg.publicUrl) -ForegroundColor Cyan