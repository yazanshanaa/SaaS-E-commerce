<#
Bring Souq Bartaa up, self-healing against this machine's crash loop.

THE LOOP WE ARE FIGHTING
  blue screen -> Docker's write to %USERPROFILE%\.docker\{daemon,windows-daemon}.json is cut
  mid-flight -> the file is left full of NUL bytes -> next launch dies with
  "parsing JSON: invalid character '\x00'" -> engine never comes up.

So the config files are deleted BEFORE every launch (absent = Docker writes fresh ones and
skips the parse entirely), and if Docker dies again while we are waiting, the script cleans up
and relaunches it by itself instead of polling a process that is no longer there.

Never call wsl.exe inside the polling loop: while WSL is building a distro that call can block
forever, which silently froze an earlier version of this script.

Everything is idempotent - images, the pnpm store and the postgres volume survive reboots, so
each run gets further than the last.
#>
$ErrorActionPreference = 'Continue'
$RepoRoot   = Split-Path -Parent $PSScriptRoot
$Log        = Join-Path $RepoRoot 'run-site.log'
$DockerExe  = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

function Note {
  param($m)
  $line = ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)
  Write-Host $line
  Add-Content -Path $Log -Value $line
}

function Clear-DockerConfig {
  foreach ($f in @('daemon.json','windows-daemon.json')) {
    $p = Join-Path $env:USERPROFILE ".docker\$f"
    if (Test-Path $p) {
      try { [System.IO.File]::SetAttributes($p, [System.IO.FileAttributes]::Normal) } catch {}
      Remove-Item $p -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-Docker {
  foreach ($n in @('Docker Desktop','com.docker.backend','com.docker.build','dockerd')) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 4
}

function Start-Docker {
  Stop-Docker
  Clear-DockerConfig
  if (Test-Path $DockerExe) { Start-Process $DockerExe | Out-Null; Note '  -> Docker Desktop launched with clean config' }
  else { Note "  -> MISSING: $DockerExe" }
}

Set-Content -Path $Log -Value "=== run-site  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Write-Host ''
Write-Host '============ SOUQ BARTAA : BRING THE SITE UP ============' -ForegroundColor Cyan
Write-Host ''

Note 'starting Docker with a clean configuration'
Start-Docker

Note 'waiting for the engine (up to ~15 min, relaunching Docker if it dies)'
$ready = $false
for ($i = 1; $i -le 180; $i++) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & docker info *> $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev

  if ($code -eq 0) { $ready = $true; Note "ENGINE UP (poll $i)"; break }

  # If Docker died (its own crash dialog kills the process), clean and relaunch rather than
  # waiting out the clock on something that will never answer.
  $alive = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
  if (-not $alive) {
    Note ("  poll {0}: Docker Desktop is gone - cleaning config and relaunching" -f $i)
    Start-Docker
  } else {
    Note ("  poll {0}: engine not ready" -f $i)
  }
  Start-Sleep -Seconds 5
}

if (-not $ready) {
  Note 'ENGINE NEVER CAME UP.'
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}

Note 'running dev-up (containers, migrations, seed, dev server)'
Write-Host ''
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dev-up.ps1') -SkipHosts
Note "dev-up exited with code $LASTEXITCODE"

try {
  Copy-Item (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') (Join-Path $RepoRoot 'hosts-snapshot.txt') -Force
  Note 'hosts file copied to hosts-snapshot.txt'
} catch { Note 'could not copy hosts file' }

try {
  $slug = & docker compose -f (Join-Path $RepoRoot 'docker-compose.dev.yml') exec -T postgres psql -U postgres -d souq_bartaa -tAc 'select slug from tenants where is_demo = true order by created_at limit 1'
  Note ("DEMO TENANT SLUG: {0}" -f ($slug | Out-String).Trim())
} catch { Note 'could not read the demo tenant slug' }

Write-Host ''
Write-Host '============ READY ============' -ForegroundColor Green
Write-Host '  admin    : http://admin.souqbartaa.test:3000'
Write-Host '  merchant : http://app.souqbartaa.test:3000'
Write-Host '  mail     : http://localhost:8025'
Write-Host '  login    : admin@souqbartaa.test  /  ChangeMe!2026'
Write-Host ''
Write-Host 'Leave the two new windows (web + worker) OPEN - they are the server.'
Write-Host ''
Read-Host 'Press Enter to close this window'
