# Souq Bartaa - start the whole development stack with one command (Windows).
#
#   scripts\dev-up.cmd
#
# Idempotent: run it again any time. Every step checks whether it has already happened, so a
# second run after a failure picks up rather than starting over.
#
# THIS FILE IS DELIBERATELY PURE ASCII. Windows PowerShell 5.1 reads .ps1 files as Windows-1252
# unless they carry a UTF-8 BOM, so a UTF-8 em-dash arrives as three bytes, one of which is a
# curly quote - and a curly quote inside a string ends it early. That is a parser error on a line
# that looks perfectly fine, followed by a cascade of nonsense errors further down. No non-ASCII
# character appears anywhere below, which makes the file immune to how it is decoded.
#
# It is also written for the powershell.exe that SHIPS with Windows, not pwsh (PowerShell 7 is a
# separate download). Native commands are called directly and checked through $LASTEXITCODE
# rather than wrapped in cmd /c, which is what produced the redirection errors before.
#
# NO ADMINISTRATOR RIGHTS AND NO HOSTS FILE. The platform routes by hostname, and .env now sets
# DOMAIN=localhost - *.localhost resolves to 127.0.0.1 in every modern browser (RFC 6761), so
# admin.localhost, app.localhost and {slug}.localhost all work with no setup at all.

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
# -LiteralPath: Set-Location treats a positional argument as a wildcard pattern, so a repo path
# containing [ or ] would silently fail to resolve.
Set-Location -LiteralPath $repo

$log = Join-Path $repo 'dev-up.log'
"=== dev-up $(Get-Date -Format s) ===" | Out-File $log -Encoding utf8

function Step($t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan; "==> $t" | Out-File $log -Append -Encoding utf8 }
function Ok($t)   { Write-Host "    $t" -ForegroundColor DarkGray; "    $t" | Out-File $log -Append -Encoding utf8 }
function Warn($t) { Write-Host "    $t" -ForegroundColor Yellow;   "  WARN $t" | Out-File $log -Append -Encoding utf8 }

function Die($t) {
  Write-Host ''
  Write-Host "FAILED: $t" -ForegroundColor Red
  "FAILED: $t" | Out-File $log -Append -Encoding utf8
  Write-Host ''
  Write-Host 'The full log is in dev-up.log - send me that file and I will fix it.' -ForegroundColor Yellow
  exit 1
}

# Run a native command, stream its output to the console AND the log, then check the exit code.
#
# THREE THINGS HERE ARE DELIBERATE, and each one was a real defect first:
#
#   1. `ForEach-Object { "$_" }` casts every pipeline item to a STRING before it is displayed.
#      With `2>&1`, a native command's stderr arrives as ErrorRecord objects, which the console
#      renders in RED - and docker, pnpm and prisma all write ordinary progress to stderr. A
#      completely successful run therefore painted the screen red and looked like a disaster.
#   2. `Out-File -Encoding utf8` rather than `Tee-Object -FilePath`. In PowerShell 5.1 Tee-Object
#      has no -Encoding parameter and writes UTF-16LE, so it was interleaving UTF-16 into a UTF-8
#      log and producing a file no editor could read - the very file this script tells the user to
#      send when something breaks.
#   3. `$global:LASTEXITCODE = 0` first. On Windows `pnpm` resolves to pnpm.ps1, a PowerShell shim,
#      and a script does not itself set $LASTEXITCODE. If it were ever $null, `$null -ne 0` is TRUE
#      and Die would fire on a command that succeeded.
function Run($label, $exe, [string[]]$argv) {
  Ok "$exe $($argv -join ' ')"
  $global:LASTEXITCODE = 0
  & $exe @argv 2>&1 | ForEach-Object {
    $line = "$_"
    Write-Host $line
    $line | Out-File $log -Append -Encoding utf8
  }
  if ($LASTEXITCODE -ne 0) { Die "$label failed (exit $LASTEXITCODE)." }
}

# ---------------------------------------------------------------------------
Step 'Checking prerequisites'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Die 'Docker is not installed or not on PATH. Install Docker Desktop, start it, then run this again.'
}

& docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Die 'Docker is installed but not running. Open Docker Desktop, wait until it says Running, then run this again.'
}
Ok 'docker: running'

# Compose V2 specifically. A machine with only the legacy docker-compose.exe passes both checks
# above and then dies at the first `docker compose` call with a generic non-zero exit and no clue.
& docker compose version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Die 'Docker Compose V2 is missing. Update Docker Desktop - this needs "docker compose", not "docker-compose".'
}
Ok 'docker compose: v2'

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Die 'pnpm is not on PATH. Run:  corepack enable   then CLOSE this window and open a new one.'
}
Ok "pnpm: $(& pnpm --version)"

if (-not (Test-Path '.env')) { Die '.env is missing. Copy .env.example to .env first.' }

$domain = 'localhost'
$domainLine = Select-String -Path '.env' -Pattern '^DOMAIN=(.+)$' | Select-Object -First 1
if ($domainLine) { $domain = $domainLine.Matches[0].Groups[1].Value.Trim() }
Ok "DOMAIN: $domain"

if ($domain -ne 'localhost') {
  Warn "DOMAIN is '$domain', not 'localhost'."
  Warn "The links printed at the end will not resolve unless that name points at 127.0.0.1"
  Warn "in your hosts file. Set DOMAIN=localhost in .env to avoid needing that."
}

# ---------------------------------------------------------------------------
Step 'Starting postgres, redis and mailpit'
Run 'docker compose up' 'docker' @('compose','-f','docker-compose.dev.yml','up','-d','postgres','redis','mailpit')

Ok 'waiting for postgres to accept connections'
$ready = $false
foreach ($attempt in 1..60) {
  # pg_isready inside the container - the same check the compose healthcheck runs, and it needs no
  # JSON parsing, which is what broke the previous version of this script on PowerShell 5.1.
  & docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U postgres -d souq_bartaa 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  & docker compose -f docker-compose.dev.yml logs --tail 40 postgres 2>&1 | Out-File $log -Append -Encoding utf8
  Die 'postgres never became ready. Its last 40 log lines are in dev-up.log.'
}
Ok 'postgres: ready'

# ---------------------------------------------------------------------------
Step 'Installing dependencies'
Run 'pnpm install' 'pnpm' @('install')

Step 'Generating the Prisma client'
# Always. The client is generated from schema.prisma, and Phase 10 added models to it. A stale
# client shows up as a pile of "property does not exist" errors that look like application bugs.
Run 'prisma generate' 'pnpm' @('db:generate')

# ---------------------------------------------------------------------------
Step 'Applying migrations'
# `db:deploy` (prisma migrate deploy), NOT `db:migrate` (prisma migrate dev).
#
# `migrate dev` is INTERACTIVE: on drift, or when it wants to name a new migration, it prints a
# prompt with no trailing newline. Through a pipe that prompt never flushes, so the script sits
# there looking frozen with nothing on screen to explain why - and if Prisma instead detects the
# non-TTY it just errors out. Either way it is the wrong command for an unattended startup.
#
# `migrate deploy` applies every committed migration and creates none, which is exactly right
# here: all of them are in prisma/migrations, including the two added on 2026-08-20/21.
Run 'prisma migrate' 'pnpm' @('db:deploy')

Step 'Seeding'
# Idempotent - it skips whatever is already there.
Run 'seed' 'pnpm' @('db:seed')

# ---------------------------------------------------------------------------
Step 'Finding the demo storefront'
$demoSlug = ''
$sql = 'SELECT slug FROM tenants WHERE is_demo = true ORDER BY created_at LIMIT 1'
$raw = & docker compose -f docker-compose.dev.yml exec -T postgres psql -U postgres -d souq_bartaa -tAc $sql 2>&1
if ($LASTEXITCODE -eq 0 -and $raw) {
  $first = ($raw | Where-Object { "$_".Trim() -ne '' } | Select-Object -First 1)
  if ($first) { $demoSlug = "$first".Trim() }
}
if ($demoSlug) { Ok "demo shop: $demoSlug" } else { Warn 'no demo shop found (the two platform surfaces still work)' }

# ---------------------------------------------------------------------------
Step 'Typechecking (warnings only - the server starts either way)'
# Phase 10 was written without a toolchain, so this is the first time any of it is compiled.
# next dev compiles lazily per route, so an error in a page nobody opens stays invisible.
$tcLog = Join-Path $repo 'typecheck.log'
$global:LASTEXITCODE = 0
# Cast to string first, for both reasons the Run function explains: red ErrorRecords on screen,
# and UTF-16 in a file that is meant to be readable and sent to me.
& pnpm typecheck 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $tcLog | Out-File $log -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) {
  Warn 'Typecheck found errors - saved to typecheck.log. Send me that file and I will fix them.'
  Warn 'Starting the server anyway; every page that compiles works normally.'
} else {
  Ok 'typecheck: clean'
  Remove-Item $tcLog -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  =============================================================' -ForegroundColor Green
Write-Host '   READY' -ForegroundColor Green
Write-Host '  =============================================================' -ForegroundColor Green
Write-Host "   Owner panel   http://admin.${domain}:3000"
Write-Host "   Merchant      http://app.${domain}:3000"
if ($demoSlug) { Write-Host "   Demo shop     http://${demoSlug}.${domain}:3000" }
Write-Host '   Dev mail      http://localhost:8025'
Write-Host ''
Write-Host '   Sign in       admin@souqbartaa.test  /  ChangeMe!2026'
Write-Host '  =============================================================' -ForegroundColor Green
Write-Host '   http://localhost:3000 returns 404 on purpose. This platform' -ForegroundColor DarkGray
Write-Host '   picks its surface from the hostname, so use the links above.' -ForegroundColor DarkGray
Write-Host '   Background jobs (optional, separate window):  pnpm worker' -ForegroundColor DarkGray
Write-Host ''

Step 'Starting the dev server. Press Ctrl+C to stop.'
& pnpm dev

# Ctrl+C makes `next dev` exit non-zero, which is a NORMAL shutdown here - without this the .cmd
# wrapper would treat it as a failure and end on "Press any key to continue".
exit 0
