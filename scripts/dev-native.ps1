<#
Souq Bartaa - bring the platform up locally on Windows WITHOUT Docker / WSL2.

This is the safe replacement for run-site.ps1 / go.ps1 / fix-wsl-and-run.ps1 / auto-fix-docker.ps1.
Those launch Docker Desktop, whose WSL2 engine bugchecks this machine (BSOD 0x7E) and reboots it.
This script never touches Docker: postgres runs via embedded-postgres, redis is skipped (the app
degrades to the database), mail is captured by an in-process sink, and the app runs with `next dev`.

  .\scripts\dev-native.ps1              # fix the hosts file (UAC once), then run the stack
  .\scripts\dev-native.ps1 -Worker      # also start the BullMQ worker (needs a native Redis on 6379)
  .\scripts\dev-native.ps1 -HostsOnly   # only write the hosts entries and exit
  .\scripts\dev-native.ps1 -ResetDb     # delete .pgdata-dev for a clean re-init, then run

Only the hosts write is elevated; postgres, node and next all run as you.
#>
[CmdletBinding()]
param(
  [switch]$Worker,
  [switch]$HostsOnly,
  [switch]$ResetDb,
  # Internal: set only when this script re-launches itself elevated to write the hosts file.
  [string]$WriteHostsOnly
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$HostsPath  = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$BlockStart = '# >>> Souq Bartaa (local dev) >>>'
$BlockEnd   = '# <<< Souq Bartaa (local dev) <<<'
$HintFile   = Join-Path $RepoRoot '.tmp\dev-native-hosts.txt'
$DataDir    = Join-Path $RepoRoot '.pgdata-dev'

function Say  { param($m) Write-Host "  $m" }
function Step { param($m) Write-Host "`n> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host "`n[x] $m" -ForegroundColor Red; exit 1 }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-EnvValue {
  param([string]$Key)
  $envFile = Join-Path $RepoRoot '.env'
  if (-not (Test-Path $envFile)) { return $null }
  foreach ($line in Get-Content $envFile) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Test-PortOpen {
  param([int]$Port)
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    $open = $iar.AsyncWaitHandle.WaitOne(800) -and $c.Connected
    if ($c.Connected) { $c.EndConnect($iar) }
    $c.Close()
    return $open
  } catch { return $false }
}

# --- hosts-file management: idempotent, backs up first, only touches our own marked block -------
function Write-HostsBlock {
  param([string[]]$Names)
  $backup = "$HostsPath.souqbartaa-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $HostsPath $backup -Force
  Say "backup: $backup"

  $existing = @(Get-Content $HostsPath -ErrorAction SilentlyContinue)
  $kept = New-Object System.Collections.Generic.List[string]
  $inBlock = $false
  foreach ($line in $existing) {
    if ($line -eq $BlockStart) { $inBlock = $true;  continue }
    if ($line -eq $BlockEnd)   { $inBlock = $false; continue }
    if (-not $inBlock) { $kept.Add($line) }
  }
  $kept.Add($BlockStart)
  $kept.Add('# Written by scripts/dev-native.ps1. Remove this block by hand to undo.')
  foreach ($n in $Names) { $kept.Add("127.0.0.1`t$n") }
  $kept.Add($BlockEnd)
  Set-Content -Path $HostsPath -Value $kept -Encoding ASCII
  Ok "hosts updated ($($Names.Count) names)"
}

function Set-HostsBlock {
  param([string[]]$Names)
  if (Test-Admin) { Write-HostsBlock -Names $Names; return }
  Warn 'Administrator rights are needed once, only to write the hosts file.'
  $joined = $Names -join ','
  $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
    '-WriteHostsOnly', "`"$joined`""
  )
  if ($proc.ExitCode -ne 0) {
    Warn 'the elevated hosts write did not succeed. Add these lines to your hosts file by hand:'
    Write-Host ''
    foreach ($n in $Names) { Write-Host "127.0.0.1`t$n" }
    Write-Host ''
  } else { Ok 'hosts updated' }
}

# --- the elevated child: writes hosts and leaves --------------------------------------------------
if ($WriteHostsOnly) {
  if (-not (Test-Admin)) { Die 'internal: -WriteHostsOnly reached without elevation.' }
  $names = $WriteHostsOnly -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  if (-not $names) { Die 'internal: -WriteHostsOnly parsed to no hostnames.' }
  Write-HostsBlock -Names $names
  exit 0
}

Set-Location $RepoRoot

Write-Host ''
Write-Host '========= SOUQ BARTAA : RUN LOCALLY (NO DOCKER) =========' -ForegroundColor Cyan

if ($ResetDb) {
  Step 'Reset: deleting .pgdata-dev for a clean re-init'
  if (Test-PortOpen 5432) { Die 'Something is still listening on 5432. Close the running stack first, then re-run -ResetDb.' }
  if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force }
  Ok 'database directory removed - it will be rebuilt on start'
}

# --- prerequisites (NOT docker) -------------------------------------------------------------------
Step 'Checking prerequisites'
foreach ($tool in @('node', 'pnpm')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Die "$tool is not on PATH. Install it and re-run.  node+pnpm: https://pnpm.io/installation"
  }
}
$nodeMajor = [int]((node -v) -replace '^v(\d+)\..*$', '$1')
if ($nodeMajor -lt 22) { Die "Node $nodeMajor found; this repo needs Node 22 or newer." }
Ok "node $(node -v), pnpm $(pnpm -v)"

if (-not (Test-Path (Join-Path $RepoRoot '.env'))) {
  Die '.env is missing. Copy .env.example to .env and fill it in before running this.'
}
$Domain = Read-EnvValue 'DOMAIN'
if (-not $Domain) { $Domain = 'souqbartaa.test' }
Ok "DOMAIN=$Domain"

# --- hosts entries: fixed surfaces now, plus the demo slug learned on the previous run ------------
Step 'Hostnames'
$names = @("$Domain", "admin.$Domain", "app.$Domain")
if (Test-Path $HintFile) {
  foreach ($n in (Get-Content $HintFile | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    if ($names -notcontains $n) { $names += $n }
  }
}
Set-HostsBlock -Names $names
Say 'first run only sets admin/app; the demo storefront hostname is added automatically next launch.'

if ($HostsOnly) { Ok 'done (hosts only).'; exit 0 }

# --- clear a stale postgres lock a crash may have left --------------------------------------------
# NOT $pid: that is a PowerShell automatic variable (this process's id) and assigning to it fails.
$pidFile = Join-Path $DataDir 'postmaster.pid'
if ((Test-Path $pidFile) -and -not (Test-PortOpen 5432)) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Say 'cleared a stale postmaster.pid from an unclean shutdown'
}

# --- run the stack (this window becomes the server) ----------------------------------------------
Step 'Starting the stack (postgres + migrate + seed + next dev)'
Say 'Postgres runs inside this process. Keep this window open - closing it stops the site.'
Write-Host ''
if ($Worker) { $env:DEV_WORKER = '1' }

$ErrorActionPreference = 'Continue'   # Node writes progress to stderr; do not let that abort us.
& pnpm exec tsx (Join-Path $RepoRoot 'scripts\dev-native.ts')
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) { Write-Host 'Stack stopped.' -ForegroundColor Green }
else { Warn "the stack exited with code $code - scroll up for the error, or run with -ResetDb if the database is wedged." }
Read-Host 'Press Enter to close'
