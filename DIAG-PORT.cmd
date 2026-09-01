@echo off
REM Writes what is holding the Postgres port into diag-port.log, so the stack's
REM "postgres already listening - reusing it" can be traced to a real process.
cd /d "%~dp0"

echo === listeners on 5432 === > diag-port.log
netstat -ano | findstr ":5432" >> diag-port.log 2>&1

echo. >> diag-port.log
echo === postgres processes (name, pid, path) === >> diag-port.log
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*postgres*' } | Select-Object ProcessId, Name, ExecutablePath | Format-List | Out-String -Width 400" >> diag-port.log 2>&1

echo. >> diag-port.log
echo === node processes running the dev stack === >> diag-port.log
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId, CommandLine | Format-List | Out-String -Width 400" >> diag-port.log 2>&1

echo. >> diag-port.log
echo === postgres windows services === >> diag-port.log
powershell -NoProfile -Command "Get-Service | Where-Object { $_.Name -like '*postgre*' } | Select-Object Name, Status | Format-List | Out-String" >> diag-port.log 2>&1

echo === done === >> diag-port.log
exit
