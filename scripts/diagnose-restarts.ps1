<#
Why does this machine keep restarting?

An unexpected restart mid-write is what fills daemon.json with NUL bytes, so the reboots are
the ROOT CAUSE of the Docker failures - not a bad disk. This pulls the evidence out of the
Windows System event log and writes it somewhere readable.

Event IDs that matter:
  41   Kernel-Power   - machine rebooted without shutting down cleanly (crash/power loss)
  6008 EventLog       - previous shutdown was unexpected
  1074 User32         - something REQUESTED a restart (app/update) - names the culprit
  1001 BugCheck       - blue screen, includes the stop code
  6013 EventLog       - uptime at time of logging
#>
$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Out      = Join-Path $RepoRoot 'restart-diagnosis.txt'

"=== restart diagnosis  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Set-Content $Out

# uptime: if this is minutes, the machine just rebooted
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Content $Out ""
  Add-Content $Out ("LAST BOOT : {0}" -f $os.LastBootUpTime)
  Add-Content $Out ("UPTIME    : {0}" -f ((Get-Date) - $os.LastBootUpTime))
} catch { Add-Content $Out "could not read boot time: $_" }

Add-Content $Out ""
Add-Content $Out "--- shutdown / crash events, newest first (last 7 days) ---"
try {
  $ev = Get-WinEvent -FilterHashtable @{
      LogName   = 'System'
      Id        = 41,1074,6008,6013,1001
      StartTime = (Get-Date).AddDays(-7)
    } -ErrorAction Stop | Select-Object -First 40
  if (-not $ev) { Add-Content $Out "(none found - that is good news)" }
  foreach ($e in $ev) {
    Add-Content $Out ""
    Add-Content $Out ("[{0}] id={1} {2}" -f $e.TimeCreated, $e.Id, $e.ProviderName)
    $msg = ($e.Message -split "`n" | Select-Object -First 6) -join ' | '
    Add-Content $Out ("    {0}" -f $msg)
  }
} catch {
  Add-Content $Out "could not read the System event log: $_"
}

# temperature - overheating is a classic cause of sudden reboots
Add-Content $Out ""
Add-Content $Out "--- thermal ---"
try {
  $t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
  foreach ($z in $t) { Add-Content $Out ("zone {0}: {1:N1} C" -f $z.InstanceName, (($z.CurrentTemperature / 10) - 273.15)) }
} catch { Add-Content $Out "no thermal sensor exposed to WMI (normal on many desktops)" }

# disk health, to close out the earlier hypothesis for good
Add-Content $Out ""
Add-Content $Out "--- physical disks ---"
try {
  Get-PhysicalDisk | ForEach-Object {
    Add-Content $Out ("{0} | {1} | health={2} | op={3}" -f $_.FriendlyName, $_.MediaType, $_.HealthStatus, ($_.OperationalStatus -join ','))
  }
} catch { Add-Content $Out "could not query physical disks: $_" }

# pending windows updates can force reboots
Add-Content $Out ""
Add-Content $Out "--- reboot pending flags ---"
foreach ($k in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')) {
  Add-Content $Out ("{0} : {1}" -f $k, (Test-Path $k))
}

Write-Host ''
Write-Host 'Diagnosis written to restart-diagnosis.txt' -ForegroundColor Green
Get-Content $Out | Select-Object -First 60
Write-Host ''
Read-Host 'Press Enter to close'
