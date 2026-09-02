<#
Docker Desktop on Windows runs its engine inside WSL2. If WSL is broken or its distros were
wiped (the factory reset removes docker-desktop*), the engine can never come up - which is
exactly the symptom: Docker Desktop "runs" but `docker info` never answers.
#>
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $RepoRoot 'wsl-check.txt'
"=== WSL check  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Set-Content $Out

function Add { param($t) Add-Content $Out $t }

Add ''; Add '--- wsl --status ---'
try { (& wsl.exe --status 2>&1 | Out-String) -split "`n" | ForEach-Object { Add $_.TrimEnd() } } catch { Add "failed: $_" }

Add ''; Add '--- wsl --list --verbose (distros; docker-desktop must be here) ---'
try { (& wsl.exe --list --verbose 2>&1 | Out-String) -split "`n" | ForEach-Object { Add $_.TrimEnd() } } catch { Add "failed: $_" }

Add ''; Add '--- wsl --version ---'
try { (& wsl.exe --version 2>&1 | Out-String) -split "`n" | ForEach-Object { Add $_.TrimEnd() } } catch { Add "failed: $_" }

Add ''; Add '--- required Windows features ---'
foreach ($f in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform','Microsoft-Hyper-V')) {
  try {
    $s = (Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction Stop).State
    Add ("{0} : {1}" -f $f, $s)
  } catch { Add ("{0} : cannot query (needs admin)" -f $f) }
}

Add ''; Add '--- docker processes running right now ---'
Get-Process | Where-Object { $_.ProcessName -match 'docker|wsl|vmmem' } |
  ForEach-Object { Add ("{0} (pid {1})" -f $_.ProcessName, $_.Id) }

Add ''; Add '--- docker cli says ---'
try { (& docker version 2>&1 | Out-String) -split "`n" | Select-Object -First 12 | ForEach-Object { Add $_.TrimEnd() } } catch { Add "failed: $_" }

Write-Host ''
Get-Content $Out
Write-Host ''
Read-Host 'Press Enter to close'
