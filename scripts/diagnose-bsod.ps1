<#
Collect the evidence needed to root-cause the blue screen (BugCheck 0x0000007e) — WITHOUT
launching Docker or booting any WSL distro, so running this can never trigger the crash.

It is 100% read-only: it queries the event log, lists crash dumps and recently-changed drivers,
reads memory and virtualization state, and (if the Windows debugger happens to be installed)
runs !analyze on the newest minidump to name the faulting driver.

  .\scripts\diagnose-bsod.ps1

Output: bsod-evidence.txt in the repo root. For the deepest signal, run it from an
Administrator PowerShell so it can read C:\Windows\Minidump.
#>
$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $RepoRoot 'bsod-evidence.txt'

function W { param($t) Add-Content -Path $Out -Value $t }
function H { param($t) Add-Content -Path $Out -Value ''; Add-Content -Path $Out -Value "--- $t ---" }

"=== BSOD evidence  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Set-Content $Out

# --- system + uptime -------------------------------------------------------------------------
H 'system'
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  W ("OS        : {0} (build {1})" -f $os.Caption, $os.BuildNumber)
  W ("Machine   : {0} | {1} logical CPUs | {2:N1} GB RAM" -f $cs.Model, $cs.NumberOfLogicalProcessors, ($cs.TotalPhysicalMemory/1GB))
  W ("Last boot : {0}" -f $os.LastBootUpTime)
  W ("Uptime    : {0}" -f ((Get-Date) - $os.LastBootUpTime))
} catch { W "could not read system info: $_" }

# --- crash / shutdown events ------------------------------------------------------------------
# 41 Kernel-Power (unclean reboot) | 1001 BugCheck (the stop code) | 6008 unexpected shutdown
# 1074 something REQUESTED a restart (names the process) | 6013 uptime at logging
H 'crash / shutdown events, newest first (last 14 days)'
try {
  $ev = Get-WinEvent -FilterHashtable @{ LogName='System'; Id=41,1074,6008,6013,1001; StartTime=(Get-Date).AddDays(-14) } -ErrorAction Stop |
        Select-Object -First 40
  if (-not $ev) { W '(none in the last 14 days)' }
  foreach ($e in $ev) {
    W ''
    W ("[{0}] id={1} {2}" -f $e.TimeCreated, $e.Id, $e.ProviderName)
    W ("    {0}" -f (($e.Message -split "`n" | Select-Object -First 4) -join ' | '))
  }
} catch { W "could not read the System event log: $_" }

# --- crash dumps on disk ----------------------------------------------------------------------
H 'crash dumps on disk'
try {
  $mini = Get-ChildItem 'C:\Windows\Minidump\*.dmp' -ErrorAction Stop | Sort-Object LastWriteTime
  if (-not $mini) { W '(no minidumps — check that Startup & Recovery is set to write a "Small memory dump")' }
  foreach ($d in $mini) { W ("{0}  {1}  ({2} KB)" -f $d.LastWriteTime, $d.Name, [int]($d.Length/1KB)) }
} catch { W "cannot list C:\Windows\Minidump (run as Administrator to read it): $_" }
$fullDump = 'C:\Windows\MEMORY.DMP'
if (Test-Path $fullDump) {
  try { $f = Get-Item $fullDump; W ("MEMORY.DMP: {0}  ({1:N0} MB)" -f $f.LastWriteTime, ($f.Length/1MB)) } catch {}
}

# --- recently changed third-party drivers (a recent one is the usual 0x7E culprit) ------------
H 'third-party drivers changed most recently (newest 25)'
try {
  Get-ChildItem 'C:\Windows\System32\drivers\*.sys' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 25 |
    ForEach-Object { W ("{0:yyyy-MM-dd}  {1}" -f $_.LastWriteTime, $_.Name) }
} catch { W "cannot list drivers: $_" }

# --- recent Windows updates -------------------------------------------------------------------
H 'recently installed updates'
try {
  Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 12 |
    ForEach-Object { W ("{0:yyyy-MM-dd}  {1}  {2}" -f $_.InstalledOn, $_.HotFixID, $_.Description) }
} catch { W "cannot list hotfixes: $_" }

# --- memory (0x7E can be unstable RAM; a consistent stop code argues against it, but rule it out) --
H 'memory modules'
try {
  Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
    W ("{0} | {1} GB | {2} MHz | {3} | PN {4}" -f $_.BankLabel, [int]($_.Capacity/1GB), $_.Speed, $_.Manufacturer, ($_.PartNumber).Trim())
  }
} catch { W "cannot read memory info: $_" }

# --- virtualization / memory integrity (the layer that crashes) -------------------------------
H 'virtualization + memory integrity'
try {
  $cs = Get-CimInstance Win32_ComputerSystem
  W ("HypervisorPresent : {0}" -f $cs.HypervisorPresent)
} catch {}
try {
  $dg = Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard -ErrorAction Stop
  $hvci = if ($dg.SecurityServicesRunning -contains 2) { 'ON' } else { 'off' }
  W ("HVCI / Memory Integrity : {0}" -f $hvci)
  W '  (if ON and a driver is faulting, turning Core Isolation > Memory Integrity OFF often stops a 0x7E)'
} catch { W "could not query Device Guard: $_" }

# --- WSL state (read-only: these query the service; they do NOT boot a distro or the VM) -------
H 'WSL (read-only)'
# NOT $args: that is a PowerShell automatic variable.
foreach ($wslArg in @('--version','--status')) {
  try { W ("wsl $wslArg :"); (& wsl.exe $wslArg 2>&1 | Out-String) -replace "`0",'' -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { W ("    {0}" -f $_.Trim()) } } catch { W "    wsl $wslArg failed: $_" }
}

# --- best-effort: name the faulting driver from the newest minidump ---------------------------
H 'automatic dump analysis'
$kd = @(
  'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\kd.exe',
  'C:\Program Files\Windows Kits\10\Debuggers\x64\kd.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$newest = Get-ChildItem 'C:\Windows\Minidump\*.dmp' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($kd -and $newest) {
  W ("analysing {0} with {1}" -f $newest.Name, (Split-Path $kd -Leaf))
  try {
    $raw = & $kd -z $newest.FullName -c '!analyze -v; q' 2>&1 | Out-String
    foreach ($pat in @('BUGCHECK_CODE','MODULE_NAME','IMAGE_NAME','FAILURE_BUCKET_ID','PROCESS_NAME','STACK_TEXT')) {
      $line = ($raw -split "`r?`n" | Where-Object { $_ -match "^\s*$pat" } | Select-Object -First 1)
      if ($line) { W ("    {0}" -f $line.Trim()) }
    }
  } catch { W "    kd analysis failed: $_" }
} else {
  W 'Windows debugger (kd.exe) not found — install it to auto-name the driver:'
  W '  winget install Microsoft.WinDbg     (then re-run this script)'
  W 'Or open the newest minidump above with the free "WhoCrashed" tool.'
}

Write-Host ''
Write-Host "Evidence written to bsod-evidence.txt" -ForegroundColor Green
Get-Content $Out
Write-Host ''
Read-Host 'Press Enter to close'
