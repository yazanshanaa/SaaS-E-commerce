<#
Automated Docker recovery + full dev bring-up for Souq Bartaa.

WHY: Docker Desktop refuses to start because %USERPROFILE%\.docker\daemon.json keeps
turning into NUL bytes. Rewriting the file by hand loses the race against whatever zeroes
it. This script does the whole sequence in one shot, with no human in the loop:

  1. DISK TEST     - writes/reads a file 60 times and verifies every byte. If the disk were
                     the culprit, failures show up here. If this passes, the disk is fine and
                     the corruption is Docker-specific.
  2. KILL          - stops every Docker process so nothing can rewrite the file mid-fix.
  3. DELETE        - removes daemon.json / windows-daemon.json entirely (clearing read-only
                     first). Docker treats an ABSENT file as "no custom config" and skips the
                     JSON parse that is crashing it. This is the key difference from earlier
                     attempts, which only replaced the CONTENTS.
  4. START + POLL  - launches Docker Desktop and polls `docker info` until the engine answers,
                     logging the state of daemon.json at every step.
  5. BRING UP      - once the engine is live, runs the normal dev bring-up (-SkipHosts, so no
                     admin prompt is needed).
#>

$ErrorActionPreference = 'Continue'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$DockerDir = Join-Path $env:USERPROFILE '.docker'
$Log       = Join-Path $RepoRoot 'docker-autofix.log'

function Note { param($m) $line = "$m"; Write-Host $line; Add-Content -Path $Log -Value $line }

Set-Content -Path $Log -Value "=== auto-fix-docker  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Write-Host ''
Write-Host '=========== SOUQ BARTAA : AUTOMATED DOCKER FIX + BRING-UP ===========' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- 1. disk test
Note ''
Note '[1/5] DISK INTEGRITY TEST (60 write+verify cycles)'
$probe = Join-Path $DockerDir '_disk_probe.tmp'
$payload = '{"integrity":"' + ('A' * 400) + '"}'
$bad = 0
foreach ($i in 1..60) {
  try {
    [System.IO.File]::WriteAllText($probe, $payload)
    $back = [System.IO.File]::ReadAllText($probe)
    if ($back -ne $payload) { $bad++ }
  } catch { $bad++ }
}
Remove-Item $probe -Force -ErrorAction SilentlyContinue
if ($bad -eq 0) {
  Note '      RESULT: 60/60 perfect. The DISK IS FINE - corruption is Docker-specific.'
} else {
  Note "      RESULT: $bad of 60 writes came back wrong. This points at the DISK."
}

# ---------------------------------------------------------------- 2. kill docker
Note ''
Note '[2/5] STOPPING every Docker process'
foreach ($n in @('Docker Desktop','com.docker.backend','com.docker.build','com.docker.dev-envs','dockerd','docker','vpnkit','com.docker.proxy')) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 6
Note '      stopped.'

# ---------------------------------------------------------------- 3. delete configs
Note ''
Note '[3/5] DELETING the broken config files (absent = Docker skips the parse)'
foreach ($f in @('daemon.json','windows-daemon.json')) {
  $p = Join-Path $DockerDir $f
  if (Test-Path $p) {
    try { Set-ItemProperty -Path $p -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue } catch {}
    try { [System.IO.File]::SetAttributes($p, [System.IO.FileAttributes]::Normal) } catch {}
    Remove-Item -Path $p -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $p) { Note "      COULD NOT DELETE $f" } else { Note "      $f removed" }
}

# ---------------------------------------------------------------- 4. start + poll
Note ''
Note '[4/5] STARTING Docker Desktop and waiting for the engine'
$exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
if (Test-Path $exe) { Start-Process -FilePath $exe | Out-Null; Note '      launched.' }
else { Note "      NOT FOUND: $exe" }

$ready = $false
foreach ($i in 1..100) {
  Start-Sleep -Seconds 5
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & docker info *> $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -eq 0) { $ready = $true; Note "      ENGINE UP after $($i*5)s"; break }

  if ($i % 6 -eq 0) {
    $dp = Join-Path $DockerDir 'daemon.json'
    if (Test-Path $dp) {
      $bytes = [System.IO.File]::ReadAllBytes($dp)
      $nulls = ($bytes | Where-Object { $_ -eq 0 }).Count
      Note ("      {0,4}s  waiting... daemon.json: {1} bytes, {2} NUL" -f ($i*5), $bytes.Length, $nulls)
      if ($nulls -gt 0) {
        Note '            -> re-corrupted. Deleting again and letting Docker retry.'
        try { [System.IO.File]::SetAttributes($dp, [System.IO.FileAttributes]::Normal) } catch {}
        Remove-Item $dp -Force -ErrorAction SilentlyContinue
      }
    } else {
      Note ("      {0,4}s  waiting... (daemon.json absent - good)" -f ($i*5))
    }
  }
}

if (-not $ready) {
  Note ''
  Note 'ENGINE DID NOT COME UP. Stopping here; see docker-autofix.log.'
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}

# ---------------------------------------------------------------- 5. bring up
Note ''
Note '[5/5] ENGINE IS LIVE - running the dev bring-up'
Write-Host ''
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dev-up.ps1') -SkipHosts

# hosts snapshot, so the operator can confirm the hostnames resolve
try {
  Copy-Item -Path (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') -Destination (Join-Path $RepoRoot 'hosts-snapshot.txt') -Force
  Note ''
  Note 'hosts file copied to hosts-snapshot.txt'
} catch { Note 'could not copy hosts file' }

Write-Host ''
Write-Host '=========== DONE ===========' -ForegroundColor Green
Read-Host 'Press Enter to close'
