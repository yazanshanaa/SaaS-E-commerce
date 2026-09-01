@echo off
REM Souq Bartaa - local bring-up. Double-click this, or run it from a terminal.
REM
REM It only forwards to scripts\dev-up.ps1, which is where the actual work and the comments are.
REM The wrapper exists because PowerShell's default execution policy blocks a double-clicked .ps1,
REM and because a .cmd is the one thing that reliably starts from Explorer on every Windows box.
REM
REM Arguments pass straight through:  dev-up.cmd -Down   /   dev-up.cmd -Reset   /   -SkipHosts
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-up.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo Bring-up failed with exit code %EXITCODE%.
)
echo.
REM Explorer closes the window the instant the script ends, taking the error message with it.
pause
exit /b %EXITCODE%
