<#
THE ACTUAL FIX.

`wsl --list --verbose` shows:      docker-desktop      Installing      2

Docker Desktop keeps its engine inside the `docker-desktop` WSL2 distro. The factory reset
deleted that distro, and every attempt to re-create it has been killed part-way by a blue
screen. WSL then leaves it permanently flagged "Installing" - and Docker will neither use it
nor re-create it, so `docker info` can never answer. No amount of waiting fixes that state.

The cure is to unregister the half-installed distro so Docker builds a fresh one:
    wsl --unregister docker-desktop        (no administrator rights required)

Then start Docker and give it a long window, since it now has to lay the distro down from
scratch. Everything after that is the normal bring-up.
#>
$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Log      = Join-Path $RepoRoot 'fix-wsl.log'
function Note { param($m) $l = ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m); Write-Host $l; Add-Content $Log $l }
Set-Content $Log "=== fix-wsl  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

Write-Host ''
Write-Host '======== FIXING THE STUCK WSL DISTRO, THEN STARTING THE SITE ========' -ForegroundColor Cyan
Write-Host ''

Note '[1] stopping Docker'
foreach ($n in @('Docker Desktop','com.docker.backend','com.docker.build','dockerd')) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 5

Note '[2] shutting WSL down'
& wsl.exe --shutdown 2>&1 | Out-Null
Start-Sleep -Seconds 5

Note '[3] unregistering the half-installed docker-desktop distro'
$r = (& wsl.exe --unregister docker-desktop 2>&1 | Out-String)
Note ("    {0}" -f ($r -replace "`0","" -replace "`r?`n",' ').Trim())

Note '[4] distros now present:'
$list = (& wsl.exe --list --verbose 2>&1 | Out-String) -replace "`0",''
foreach ($line in ($list -split "`r?`n")) { if ($line.Trim()) { Note ("    {0}" -f $line.Trim()) } }

Note '[5] clearing any crash-damaged Docker config'
foreach ($f in @('daemon.json','windows-daemon.json')) {
  $p = Join-Path $env:USERPROFILE ".docker\$f"
  if (Test-Path $p) {
    try { [System.IO.File]::SetAttributes($p, [System.IO.FileAttributes]::Normal) } catch {}
    Remove-Item $p -Force -ErrorAction SilentlyContinue
  }
}

Note '[6] starting Docker Desktop - it must now BUILD the distro, so this takes a few minutes'
$exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
if (Test-Path $exe) { Start-Process $exe | Out-Null } else { Note "MISSING: $exe" }

$ready = $false
foreach ($i in 1..144) {                     # up to 12 minutes
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & docker info *> $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -eq 0) { $ready = $true; Note "    ENGINE UP after $($i*5)s"; break }
  if ($i % 6 -eq 0) {
    $st = ((& wsl.exe --list --verbose 2>&1 | Out-String) -replace "`0",'' -split "`r?`n" |
            Where-Object { $_ -match 'docker-desktop' }) -join ' '
    Note ("    {0}s  distro: {1}" -f ($i*5), $st.Trim())
  }
  Start-Sleep -Seconds 5
}

if (-not $ready) { Note 'engine still down after 12 minutes.'; Read-Host 'Press Enter to close'; exit 1 }

Note '[7] ENGINE LIVE - bringing the platform up'
Write-Host ''
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dev-up.ps1') -SkipHosts
Note "dev-up exited with $LASTEXITCODE"

try { Copy-Item (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') (Join-Path $RepoRoot 'hosts-snapshot.txt') -Force } catch {}
try {
  $slug = & docker compose -f (Join-Path $RepoRoot 'docker-compose.dev.yml') exec -T postgres psql -U postgres -d souq_bartaa -tAc 'select slug from tenants where is_demo = true order by created_at limit 1'
  Note ("demo slug: {0}" -f ($slug | Out-String).Trim())
} catch {}

Write-Host ''
Write-Host '======== DONE - keep this window open ========' -ForegroundColor Green
Read-Host 'Press Enter to close'
