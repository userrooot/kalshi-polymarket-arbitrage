<#
.SYNOPSIS
  Deploy the bot to the VPS from Windows. Run from the repo root.
.EXAMPLE
  .\deploy\deploy.ps1 -HostName ec2-x-x-x-x.eu-west-2.compute.amazonaws.com -Key C:\path\bot-uk-key.pem -KalshiPem C:\path\kalshi.pem
  .\deploy\deploy.ps1 -HostName <host> -DryRun
  (-HostName may be omitted if $env:BTCARB_HOST is set)
#>
[CmdletBinding()]
param(
  [string]$Key,
  [string]$HostName = $env:BTCARB_HOST,
  [string]$User = 'ubuntu',
  [string]$EnvFile = '.env',
  [string]$KalshiPem,
  [switch]$DryRun,
  [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'

if (-not $Key) {
  if (Test-Path '.\bot-uk-key.pem') { $Key = (Resolve-Path '.\bot-uk-key.pem').Path }
  elseif ($DryRun) { $Key = '.\bot-uk-key.pem' }
  else { $Key = (Read-Host 'Path to SSH key (bot-uk-key.pem)').Trim().Trim('"') }
}
if (-not $HostName) { throw 'Missing -HostName <EC2 public DNS> (or set $env:BTCARB_HOST).' }
if (-not ((Test-Path 'package.json') -and (Test-Path 'deploy'))) { throw 'Run from the repo root.' }
if (-not $DryRun) {
  if (-not (Test-Path $Key)) { throw "Key not found: $Key" }
  if ($KalshiPem -and -not (Test-Path $KalshiPem)) { throw "Kalshi pem not found: $KalshiPem" }
  if (-not (Test-Path $EnvFile)) { Write-Warning "$EnvFile not found; the VPS will fall back to .env.example (no Kalshi keys)." }
}
foreach ($t in 'ssh', 'scp') {
  if (-not $DryRun -and -not (Get-Command $t -ErrorAction SilentlyContinue)) { throw "$t not found. Install the Windows OpenSSH Client (Settings > Optional features)." }
}

$sshOpts = @('-i', $Key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')
$target = "$User@$HostName"
$skip = if ($SkipTests) { 1 } else { 0 }

function Show([string]$exe, [string[]]$argv) {
  Write-Host ("+ $exe " + (($argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')) -ForegroundColor Cyan
}
function Run([string]$exe, [string[]]$argv) {
  Show $exe $argv
  if ($DryRun) { return }
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe failed with exit code $LASTEXITCODE" }
}

# (a) key permissions: ssh refuses keys readable by other users
Write-Host '== key permissions ==' -ForegroundColor Yellow
$me = "$env:USERDOMAIN\$env:USERNAME"
$icaclsArgs1 = @($Key, '/inheritance:r')
$icaclsArgs2 = @($Key, '/grant:r', "${me}:(R)")
Show 'icacls' $icaclsArgs1; Show 'icacls' $icaclsArgs2
if (-not $DryRun) {
  try {
    & icacls @icaclsArgs1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
    & icacls @icaclsArgs2 | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
  } catch {
    Write-Warning "Could not fix key permissions automatically. Run manually:"
    Write-Host "  icacls `"$Key`" /inheritance:r"
    Write-Host "  icacls `"$Key`" /grant:r `"${me}:(R)`""
  }
}

# (b) pack working tree
Write-Host '== pack working tree (excluding .git node_modules data secrets .env *.pem) ==' -ForegroundColor Yellow
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('btcarb-' + [guid]::NewGuid().ToString('N'))
$archive = Join-Path $tmp 'btcarb.tar.gz'
$excludeRx = '^(\.git/|node_modules/|data/|secrets/)|(^|/)\.env$|\.pem$'
Write-Host "+ git ls-files -co --exclude-standard | filter > files.txt ; tar.exe -czf $archive -T files.txt" -ForegroundColor Cyan
if (-not $DryRun) {
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $files = & git ls-files -co --exclude-standard | Where-Object { $_ -notmatch $excludeRx }
  if ($LASTEXITCODE -ne 0 -or -not $files) { throw 'git ls-files failed or returned nothing' }
  # Use the Windows built-in bsdtar (Windows 10 1803+) explicitly: a GNU tar from Git/MSYS earlier on PATH
  # would treat "C:\..." as a remote host. (Compress-Archive is not a fallback: it flattens directories.)
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $tarExe)) { throw "tar.exe not found at $tarExe (needs Windows 10 1803 or later). Use deploy/deploy.sh from WSL instead." }
  $list = Join-Path $tmp 'files.txt'
  [IO.File]::WriteAllLines($list, [string[]]$files, (New-Object Text.UTF8Encoding($false)))
  & $tarExe -czf $archive -T $list
  if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
  Write-Host ("archive: {0:N1} KB" -f ((Get-Item $archive).Length / 1KB))
}
$remoteName = '/tmp/btcarb.tar.gz'
# Files checked out on Windows may have CRLF endings (core.autocrlf); bash on the VPS needs LF.
$extract = "tar -xzf $remoteName -C ~/btcarb && sed -i 's/\r`$//' ~/btcarb/deploy/*.sh ~/btcarb/deploy/*.service"

# upload + extract (data/ and .env were excluded so they are preserved)
Write-Host '== upload and extract (existing data/ and .env are preserved) ==' -ForegroundColor Yellow
Run 'ssh' ($sshOpts + @($target, 'mkdir -p ~/btcarb ~/btcarb/data ~/btcarb/secrets && chmod 700 ~/btcarb/secrets && { [ -f ~/btcarb/.env ] || install -m 600 /dev/null ~/btcarb/.env; }'))
try { Run 'scp' ($sshOpts + @($archive, "${target}:$remoteName")) }
finally { if (-not $DryRun -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp } }
Run 'ssh' ($sshOpts + @($target, "$extract && rm -f $remoteName && chmod +x ~/btcarb/deploy/*.sh"))

# (c) secrets (contents never printed)
Write-Host '== secrets (contents never printed) ==' -ForegroundColor Yellow
if ($DryRun -or (Test-Path $EnvFile)) {
  Run 'scp' ($sshOpts + @($EnvFile, "${target}:btcarb/.env"))
  Run 'ssh' ($sshOpts + @($target, 'chmod 600 ~/btcarb/.env'))
}
if ($KalshiPem) {
  $pemName = Split-Path $KalshiPem -Leaf
  Run 'scp' ($sshOpts + @($KalshiPem, "${target}:btcarb/secrets/$pemName"))
  Run 'ssh' ($sshOpts + @($target, 'chmod 600 ~/btcarb/secrets/*.pem'))
}

# (d) setup
Write-Host '== setup on VPS ==' -ForegroundColor Yellow
Run 'ssh' (@('-t') + $sshOpts + @($target, "SKIP_TESTS=$skip bash ~/btcarb/deploy/setup-vps.sh"))


# (e) next steps
Write-Host ''
Write-Host '== next steps ==' -ForegroundColor Yellow
Write-Host 'Dashboard (VPS binds 127.0.0.1 only; do NOT open port 3000 in the security group):'
Write-Host "  ssh -i `"$Key`" -L 3000:localhost:3000 $target     then open http://localhost:3000"
Write-Host 'Logs:'
Write-Host "  ssh -i `"$Key`" $target `"journalctl -u btcarb -f`""
if ($DryRun) { Write-Host '(dry run: nothing was executed)' }
