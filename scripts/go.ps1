<#
ONE script, one double-click: recover Docker, bring Souq Bartaa up, and collect the evidence
needed to stop the blue screens - all inside the ~25 minute window between crashes.

Ordering is deliberate: Docker Desktop needs the most wall-clock time, so it is launched FIRST
and the driver/update forensics run while it is still initialising, costing nothing.
#>
$ErrorActionPreference = 'Continue'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$DockerDir = Join-Path $env:USERPROFILE '.docker'
$Log       = Join-Path $RepoRoot 'go.log'
$Eviden    = Join-Path $RepoRoot 'bsod-evidence.txt'

function Note { param($m) $l = ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m); Write-Host $l; Add-Content $Log $l }
Set-Content $Log "=== go  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

Write-Host ''
Write-Host '============ SOUQ BARTAA : ONE-SHOT BRING-UP ============' -ForegroundColor Cyan
Write-Host ''

# --- 1. clear the wreckage a crash leaves behind, then start Docker immediately -------------
Note '[1] cleaning Docker config left broken by the last crash'
foreach ($n in @('Docker Desktop','com.docker.backend','com.docker.build','dockerd')) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 4
foreach ($f in @('daemon.json','windows-daemon.json')) {
  $p = Join-Path $DockerDir $f
  if (Test-Path $p) {
    try { [System.IO.File]::SetAttributes($p, [System.IO.FileAttributes]::Normal) } catch {}
    Remove-Item $p -Force -ErrorAction SilentlyContinue
  }
}
Note '    configs cleared'

Note '[2] starting Docker Desktop (this is the long pole - starting it first)'
$exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
if (Test-Path $exe) { Start-Process $exe | Out-Null; Note '    launched' } else { Note "    MISSING: $exe" }

# --- 2. forensics, for free, while Docker boots ---------------------------------------------
Note '[3] collecting blue-screen evidence while Docker initialises'
"=== BSOD evidence  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Set-Content $Eviden
Add-Content $Eviden ''
Add-Content $Eviden '--- crash dumps on disk (newest last) ---'
try {
  Get-ChildItem 'C:\Windows\Minidump\*.dmp' -ErrorAction Stop |
    Sort-Object LastWriteTime | ForEach-Object { Add-Content $Eviden ("{0}  {1} KB" -f $_.LastWriteTime, [int]($_.Length/1KB)) }
} catch { Add-Content $Eviden "cannot list minidumps (needs admin): $_" }

Add-Content $Eviden ''
Add-Content $Eviden '--- third-party drivers, newest 25 (a recent one is the usual culprit) ---'
try {
  Get-ChildItem 'C:\Windows\System32\drivers\*.sys' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 25 |
    ForEach-Object { Add-Content $Eviden ("{0:yyyy-MM-dd}  {1}" -f $_.LastWriteTime, $_.Name) }
} catch { Add-Content $Eviden "cannot list drivers: $_" }

Add-Content $Eviden ''
Add-Content $Eviden '--- recently installed Windows updates ---'
try { Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 12 |
        ForEach-Object { Add-Content $Eviden ("{0:yyyy-MM-dd}  {1}  {2}" -f $_.InstalledOn, $_.HotFixID, $_.Description) } }
catch { Add-Content $Eviden "cannot list hotfixes: $_" }

Add-Content $Eviden ''
Add-Content $Eviden '--- memory ---'
try {
  Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
    Add-Content $Eviden ("{0} | {1} GB | {2} MHz | {3}" -f $_.BankLabel, [int]($_.Capacity/1GB), $_.Speed, $_.Manufacturer)
  }
} catch { Add-Content $Eviden "cannot read memory info: $_" }
Note '    written to bsod-evidence.txt'

# --- 3. wait for the engine ------------------------------------------------------------------
Note '[4] waiting for the Docker engine'
$ready = $false
foreach ($i in 1..96) {           # up to 8 minutes
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & docker info *> $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -eq 0) { $ready = $true; Note "    ENGINE UP after $($i*5)s"; break }
  if ($i % 4 -eq 0) { Note ("    still waiting ({0}s)" -f ($i*5)) }
  Start-Sleep -Seconds 5
}
if (-not $ready) { Note 'engine did not start within 8 minutes.'; Read-Host 'Press Enter to close'; exit 1 }

# --- 4. bring the platform up ----------------------------------------------------------------
Note '[5] containers + migrate + seed + dev server'
Write-Host ''
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dev-up.ps1') -SkipHosts
Note "dev-up exited with $LASTEXITCODE"

try { Copy-Item (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') (Join-Path $RepoRoot 'hosts-snapshot.txt') -Force; Note 'hosts copied' } catch {}
try {
  $slug = & docker compose -f (Join-Path $RepoRoot 'docker-compose.dev.yml') exec -T postgres psql -U postgres -d souq_bartaa -tAc 'select slug from tenants where is_demo = true order by created_at limit 1'
  Note ("demo slug: {0}" -f ($slug | Out-String).Trim())
} catch {}

Write-Host ''
Write-Host '============ DONE - leave this window open ============' -ForegroundColor Green
Read-Host 'Press Enter to close'
