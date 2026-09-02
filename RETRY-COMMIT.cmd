@echo off
REM ===========================================================================
REM  BACKUP-AND-PUSH.cmd got as far as creating and pushing the phase-8-11
REM  branch, then the commit failed:
REM
REM      fatal: Unable to create '.../.git/index.lock': File exists.
REM
REM  So the branch is on GitHub pointing at Phase 7, and the eighteen days are
REM  still only on this disk. Something held the git index - an editor running
REM  a background `git status` is the usual one - or a git process died and
REM  left the lock behind.
REM
REM  This does NOT delete the lock blindly. A lock deleted while a real git
REM  process is mid-write corrupts the index. It checks for a running git
REM  first, and stops with instructions if it finds one. (The index itself is
REM  rebuildable - it is not history - but there is no reason to gamble.)
REM
REM  Unattended. Writes retry.log; last line is RETRY-COMPLETE.
REM ===========================================================================

cd /d "%~dp0"
set LOG=retry.log

echo Souq Bartaa retry-commit - %DATE% %TIME% > %LOG%
echo. >> %LOG%

echo   [1/4] is anything holding the index? ...
echo =============== RUNNING GIT PROCESSES =============== >> %LOG%
tasklist /fi "imagename eq git.exe" >> %LOG% 2>&1
echo. >> %LOG%
echo =============== THE LOCK =============== >> %LOG%
dir ".git\index.lock" >> %LOG% 2>&1
echo. >> %LOG%

tasklist /fi "imagename eq git.exe" 2>nul | find /i "git.exe" >nul
if not errorlevel 1 (
  echo   A git process is RUNNING. Stopping - close your editor and re-run.
  echo GIT_RUNNING=yes - refused to touch the lock >> %LOG%
  echo RETRY-COMPLETE >> %LOG%
  goto :end
)
echo GIT_RUNNING=no >> %LOG%

echo   [2/4] clearing the stale lock ...
if exist ".git\index.lock" del /f /q ".git\index.lock"
echo DEL_EXIT=%ERRORLEVEL% >> %LOG%
if exist ".git\index.lock" (
  echo   Could not remove the lock. Stopping.
  echo LOCK_STILL_PRESENT=yes >> %LOG%
  echo RETRY-COMPLETE >> %LOG%
  goto :end
)
echo LOCK_CLEARED=yes >> %LOG%
echo. >> %LOG%

echo   [3/4] commit ...
echo =============== ADD + COMMIT =============== >> %LOG%
call git add -A >> %LOG% 2>&1
echo ADD_EXIT=%ERRORLEVEL% >> %LOG%
call git commit -m "Phases 8-11: cart and checkout, nine templates, backups screen, dashboard kit" -m "Eighteen days of work, five migrations included, that had never left one disk. On a branch rather than main so CI reports before anything merges - and so the suite runs somewhere it can, which Windows cannot do (see GATES.cmd)." -m "Also carries three fixes for failures the suite had been hiding: a zod parser that rejected its own output (.optional -> .nullish, three sites), a CHECK constraint that forbade the backorder policy the code documents, and the CI minio KMS key that had stopped pnpm test from ever running. See deploy/CI-FINDINGS.md." >> %LOG% 2>&1
echo COMMIT_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [4/4] push ...
echo =============== PUSH =============== >> %LOG%
call git push -u origin phase-8-11 >> %LOG% 2>&1
echo PUSH_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo =============== STATE AFTER =============== >> %LOG%
call git log --oneline -3 >> %LOG% 2>&1
call git status --branch --porcelain=v1 >> %LOG% 2>&1
echo. >> %LOG%

echo RETRY-COMPLETE >> %LOG%

:end
echo.
echo   Done - retry.log
