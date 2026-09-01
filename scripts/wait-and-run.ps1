<#
Waits for the Docker engine to answer, then runs the full Souq Bartaa dev bring-up.

Does NOT kill or restart Docker (the subscription agreement has just been accepted and the
engine is initialising). Logs every poll to wait-and-run.log so progress can be followed
from outside this window.
#>
$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Log      = Join-Path $RepoRoot 'wait-and-run.log'

function Note { param($m) $line = ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m); Write-Host $line; Add-Content -Path $Log -Value $line }

Set-Content -Path $Log -Value "=== wait-and-run  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Write-Host ''
Write-Host '========== WAITING FOR DOCKER, THEN STARTING SOUQ BARTAA ==========' -ForegroundColor Cyan
Write-Host ''

$ready = $false
foreach ($i in 1..120) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & docker info *> $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -eq 0) { $ready = $true; Note 'DOCKER ENGINE IS UP'; break }
  Note ("waiting for engine... ({0}s)" -f ($i*5))
  Start-Sleep -Seconds 5
}

if (-not $ready) {
  Note 'engine never answered after 10 minutes.'
  Read-Host 'Press Enter to close'
  exit 1
}

Note 'starting containers + migrate + seed + dev server'
Write-Host ''
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dev-up.ps1') -SkipHosts
Note "dev-up finished with exit code $LASTEXITCODE"

# Snapshot of hosts + the demo slug, so the operator can verify the URLs resolve.
try {
  Copy-Item (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') (Join-Path $RepoRoot 'hosts-snapshot.txt') -Force
  Note 'hosts copied to hosts-snapshot.txt'
} catch { Note 'could not copy hosts' }

try {
  $slug = & docker compose -f (Join-Path $RepoRoot 'docker-compose.dev.yml') exec -T postgres psql -U postgres -d souq_bartaa -tAc 'select slug from tenants where is_demo = true order by created_at limit 1'
  Note ("demo tenant slug: {0}" -f ($slug | Out-String).Trim())
} catch { Note 'could not read demo slug' }

Write-Host ''
Write-Host '========== BRING-UP COMPLETE ==========' -ForegroundColor Green
Read-Host 'Press Enter to close'
