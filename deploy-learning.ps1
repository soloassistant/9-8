<#
  Deploy the Learning platform Web MVP static bundle.

  Target host layout:
    /home/afang/learning-platform/
      releases/<commit>/     immutable per-release static files
      current -> releases/<commit>
      server.js              static server (scripts/learning-web-server.js)
    systemd user unit: learning-web.service   (127.0.0.1:4173)
    cloudflared tunnel publishes it at the public URL below.

  Usage:
    .\deploy-learning.ps1                 # build then deploy HEAD short sha
    .\deploy-learning.ps1 -SkipBuild      # deploy existing dist-learning
    .\deploy-learning.ps1 -DryRun         # print actions without changing anything

  First-time setup on the target (done once):
    - server.js placed under RemoteRoot (this script syncs it)
    - ~/.config/systemd/user/learning-web.service installed and enabled
  SSH alias comes from ~/.ssh/config (192.168.3.82, user afang).
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string]$TargetHost = '192.168.3.82',
  [string]$RemoteRoot = '/home/afang/learning-platform',
  [string]$ServiceName = 'learning-web.service',
  [string]$PublicUrl = 'https://fzh-learn.msit.ltd/',
  [string]$ReleaseId,
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot can be empty under powershell.exe -File; derive it defensively.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
if (-not $ConfigPath) { $ConfigPath = Join-Path $ScriptDir '.deploy-config.json' }
Set-Location $ScriptDir

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Invoke-Remote($cmd) {
  if ($DryRun) { Write-Note "[dry-run] ssh $TargetHost $cmd"; return }
  $out = & ssh -o BatchMode=yes $TargetHost $cmd 2>&1
  if ($LASTEXITCODE -ne 0) { throw "remote command failed (exit $LASTEXITCODE): $cmd`n$out" }
  return $out
}

function Copy-ToRemote($local, $remote) {
  if ($DryRun) { Write-Note "[dry-run] scp $local -> ${TargetHost}:$remote"; return }
  & scp -o BatchMode=yes $local "${TargetHost}:$remote" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scp failed: $local -> $remote" }
}

if (Test-Path $ConfigPath) {
  $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  if ($cfg.host)            { $TargetHost = $cfg.host }
  if ($cfg.remoteRoot)      { $RemoteRoot = $cfg.remoteRoot }
  if ($cfg.publicUrl)       { $PublicUrl = $cfg.publicUrl }
  if ($cfg.learningService) { $ServiceName = $cfg.learningService }
}

# 1. release id = short sha, matching the existing releases/29ef868 naming
if (-not $ReleaseId) {
  $ReleaseId = (& git rev-parse --short=7 HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $ReleaseId) { throw 'cannot resolve HEAD short sha; pass -ReleaseId explicitly' }
}
if ((& git status --porcelain)) {
  Write-Note "working tree has uncommitted changes; release $ReleaseId may not match the artifact"
}

# 2. build
$dist = Join-Path $ScriptDir 'dist-learning'
if (-not $SkipBuild) {
  Write-Step 'build dist-learning'
  & corepack yarn workspace @learning/web build
  if ($LASTEXITCODE -ne 0) { throw 'web build failed' }
}
if (-not (Test-Path (Join-Path $dist 'index.html'))) { throw "missing $dist\index.html, build first" }

# 3. artifact self-check: index-control files must exist, otherwise they silently stop working
Write-Step 'artifact self-check'
foreach ($f in @('index.html', 'robots.txt', '_headers')) {
  $p = Join-Path $dist $f
  if (-not (Test-Path $p)) { throw "artifact missing $f - missing robots.txt/_headers silently disables index control" }
  if ((Get-Item $p).Length -le 0) { throw "artifact $f is empty" }
}
if ((Get-Content (Join-Path $dist 'robots.txt') -Raw) -notmatch 'Disallow:\s*/') { throw 'robots.txt has no "Disallow: /"' }
if ((Get-Content (Join-Path $dist 'index.html') -Raw) -notmatch 'noindex') { throw 'index.html has no noindex meta' }
$bundle = Get-ChildItem (Join-Path $dist 'assets') -Filter *.js | Select-Object -First 1
Write-Host ("    bundle={0}  robots.txt={1}B" -f $bundle.Name, (Get-Item (Join-Path $dist 'robots.txt')).Length)

# 4. reachability
Write-Step "check target host $TargetHost"
Invoke-Remote 'hostname' | Out-Null

$remoteRelease = "$RemoteRoot/releases/$ReleaseId"
Write-Step "prepare remote release $ReleaseId"

# Releases are immutable: refuse to write into an existing one, otherwise a
# partial upload could mix files from two builds. Use -ReleaseId to override.
$exists = Invoke-Remote "test -e '$remoteRelease' && echo yes || echo no"
if ($exists -match 'yes') {
  throw "remote release already exists: $remoteRelease - pass a different -ReleaseId (or remove it) so releases stay immutable"
}

# Upload into a staging directory, then rename into place so the release only
# ever appears complete.
$remoteStaging = "$RemoteRoot/.staging-$ReleaseId"
Invoke-Remote "rm -rf '$remoteStaging'; mkdir -p '$remoteStaging/assets'"

# 5. upload first; switch the symlink last so the site never serves a half release
Write-Step 'upload artifacts'
foreach ($f in @('index.html', 'robots.txt', '_headers', 'logo.png', 'share-cover.png')) {
  $p = Join-Path $dist $f
  if (Test-Path $p) { Copy-ToRemote $p "$remoteStaging/$f" }
}
Get-ChildItem (Join-Path $dist 'assets') -File | ForEach-Object {
  Copy-ToRemote $_.FullName "$remoteStaging/assets/$($_.Name)"
}
Write-Step 'sync static server'
Copy-ToRemote (Join-Path $ScriptDir 'scripts\learning-web-server.js') "$RemoteRoot/server.js"

Write-Step "publish staging -> releases/$ReleaseId"
Invoke-Remote "mv -T '$remoteStaging' '$remoteRelease'; ls '$remoteRelease' | tr '\n' ' '; echo"

# 6. atomic symlink flip (mv -T replaces the link itself)
Write-Step "switch current -> releases/$ReleaseId"
Invoke-Remote "ln -sfn '$remoteRelease' '$RemoteRoot/current.new'; mv -Tf '$RemoteRoot/current.new' '$RemoteRoot/current'; readlink -f '$RemoteRoot/current'"

# 7. restart service
Write-Step "restart $ServiceName"
Invoke-Remote "systemctl --user restart $ServiceName; sleep 2; systemctl --user is-active $ServiceName"

if ($DryRun) { Write-Host "`n[dry-run] nothing was changed" -ForegroundColor Yellow; return }

# 8. verify origin then public URL
Write-Step 'verify origin (target localhost:4173)'
Invoke-Remote "curl -s -m 5 -o /dev/null -w 'robots.txt -> %{http_code} %{content_type}\n' http://127.0.0.1:4173/robots.txt"
Invoke-Remote "curl -s -m 5 -o /dev/null -w 'index.html -> %{http_code} %{content_type}\n' http://127.0.0.1:4173/index.html"

Write-Step "verify public URL $PublicUrl"
$cb = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
try {
  $rb = Invoke-WebRequest -Uri "${PublicUrl}robots.txt?cb=$cb" -TimeoutSec 30 -UseBasicParsing
  Write-Host ("    status={0} type={1} bytes={2}" -f $rb.StatusCode, $rb.Headers['Content-Type'], $rb.Content.Length)
  Write-Host ("    X-Robots-Tag: {0}" -f $rb.Headers['X-Robots-Tag'])
  if (-not ($rb.Headers['Content-Type'] -like 'text/plain*')) { Write-Note 'robots.txt is not text/plain' }
  if ($rb.Content -notmatch 'Disallow:\s*/') { Write-Note 'public robots.txt content is wrong' }

  # NOTE: do not name this $home - PowerShell variables are case-insensitive and
  # $HOME is a read-only automatic variable, which makes assignment fail.
  $homePage = Invoke-WebRequest -Uri $PublicUrl -TimeoutSec 30 -UseBasicParsing
  $live = ''
  if ($homePage.Content -match 'assets/([A-Za-z0-9._-]+\.js)') { $live = $Matches[1] }
  Write-Host ("    live bundle = {0}" -f $live)
  Write-Host ("    local bundle = {0}" -f $bundle.Name)
  if ($live -and $live -ne $bundle.Name) {
    Write-Note 'live bundle differs from local build: either cached or release not effective'
  } else {
    Write-Host '    live artifact matches the local build' -ForegroundColor Green
  }
} catch {
  Write-Note "public verification failed: $($_.Exception.Message)"
}

Write-Host "`ndeployed: $PublicUrl (release $ReleaseId)" -ForegroundColor Green
Write-Note 'Cloudflare edge may still hold a stale entry for paths cached before this deploy;'
Write-Note 'robots.txt now returns no-store so new entries are not cached, but the old one'
Write-Note 'must expire (or be purged manually) before the edge serves the corrected file.'
