@echo off
REM ===========================================================================
REM  Commit and push whatever is currently uncommitted on phase-8-11.
REM  Same index.lock guard as RETRY-COMMIT.cmd: a lock deleted while a real git
REM  process is mid-write corrupts the index, so this checks for a running git
REM  before touching it and stops if it finds one.
REM
REM  Unattended. Writes pushfix.log; last line is PUSHFIX-COMPLETE.
REM ===========================================================================

cd /d "%~dp0"
set LOG=pushfix.log

echo Souq Bartaa push-fix - %DATE% %TIME% > %LOG%
echo. >> %LOG%

echo =============== BRANCH + STATUS =============== >> %LOG%
call git status --branch --porcelain=v1 >> %LOG% 2>&1
echo. >> %LOG%

tasklist /fi "imagename eq git.exe" 2>nul | find /i "git.exe" >nul
if not errorlevel 1 (
  echo   A git process is RUNNING. Stopping - close your editor and re-run.
  echo GIT_RUNNING=yes - refused to touch the lock >> %LOG%
  echo PUSHFIX-COMPLETE >> %LOG%
  goto :end
)
echo GIT_RUNNING=no >> %LOG%
if exist ".git\index.lock" del /f /q ".git\index.lock"

echo   [1/2] commit ...
echo =============== ADD + COMMIT =============== >> %LOG%
call git add -A >> %LOG% 2>&1
call git commit -F COMMIT-MSG.txt >> %LOG% 2>&1
echo COMMIT_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [2/2] push ...
echo =============== PUSH =============== >> %LOG%
call git push >> %LOG% 2>&1
echo PUSH_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

call git log --oneline -3 >> %LOG% 2>&1
echo. >> %LOG%
echo PUSHFIX-COMPLETE >> %LOG%

:end
echo.
echo   Done - pushfix.log
