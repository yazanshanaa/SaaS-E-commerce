@echo off
REM ===========================================================================
REM  Clean restart for the local stack.
REM
REM  Closing the START-HERE window kills its node process but ORPHANS the
REM  embedded postgres it started. The orphan keeps listening on 5432, so the
REM  next run says "postgres already listening - reusing it", connects, and then
REM  blocks forever on the role/database setup because the dead session's locks
REM  were never released.
REM
REM  So: kill whatever owns the port (by port, not by name - the orphan's
REM  executable path is unreadable, which is why a name filter missed it), kill
REM  any leftover postgres.exe and dev-native node processes, then start fresh.
REM  This machine has no PostgreSQL service installed (see diag-port.log), so
REM  nothing outside this project is affected.
REM ===========================================================================

cd /d "%~dp0"

echo.
echo   Clearing leftovers from the previous run...

powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*dev-native*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5432 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-Process postgres -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

timeout /t 5 /nobreak >nul

REM A force-killed postmaster leaves this behind; the port is free now, so it is stale.
if exist ".pgdata-dev\postmaster.pid" del /f /q ".pgdata-dev\postmaster.pid"

echo   Starting Souq Bartaa (no Docker). Takes a couple of minutes.
echo.

call pnpm exec tsx scripts/dev-native.ts

echo.
echo   The stack has stopped.
pause
