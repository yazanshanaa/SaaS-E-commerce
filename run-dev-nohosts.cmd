@echo off
REM Auto-generated launcher: full dev bring-up WITHOUT touching the hosts file (no admin/UAC needed).
REM The hosts step is the only part of dev-up.ps1 that requires elevation; -SkipHosts prints the
REM hostnames instead of writing them. Safe if the Souq Bartaa hosts block already exists.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-up.ps1" -SkipHosts
echo.
echo ==================== finished (SkipHosts) ====================
pause
