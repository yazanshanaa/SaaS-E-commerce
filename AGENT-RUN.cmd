@echo off
REM ===========================================================================
REM  Souq Bartaa - ONE-CLICK run for the current agent session.
REM  Double-click this file once, then leave it alone.
REM
REM  NO DOCKER is touched anywhere in here. The stack is scripts\dev-native.ts,
REM  exactly as START-HERE.cmd runs it: embedded postgres in-process, no redis,
REM  mail captured to .tmp\dev-mail.json.
REM
REM  What it does, in order:
REM    1. downloads the Rubik arabic-subset woff2 pair (Phase 11 / Q32)
REM    2. opens the platform in a SECOND window (keep that one open)
REM    3. records git state
REM    4. runs typecheck + lint + the full test suite
REM
REM  Everything lands in agent-report.log. Every section records its own exit
REM  code and the run CONTINUES after a failure, so one red check does not hide
REM  the others.
REM ===========================================================================

cd /d "%~dp0"
set LOG=agent-report.log

REM  The test harness boots its OWN postgres. 5433 sits above the dev cluster's
REM  5432 and below the Hyper-V reserved ranges - same reason as QA-CHECK.cmd.
set EMBEDDED_PG_PORT=5433

echo Souq Bartaa agent sweep - %DATE% %TIME% > %LOG%
echo. >> %LOG%

echo.
echo   [1/5] fetching the Rubik arabic subset ...
echo =============== FETCH-RUBIK =============== >> %LOG%
call node scripts\fetch-rubik.mjs >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [2/5] starting the platform in a second window ...
start "Souq Bartaa - stack (keep open)" cmd /c "%~dp0START-HERE.cmd"

echo   [3/5] recording git state ...
echo =============== GIT BRANCH + STATUS =============== >> %LOG%
call git status --branch --porcelain=v1 >> %LOG% 2>&1
echo. >> %LOG%
echo =============== GIT LOG (last 20) =============== >> %LOG%
call git log --oneline -20 >> %LOG% 2>&1
echo. >> %LOG%
echo =============== GIT DIFF --STAT =============== >> %LOG%
call git diff --stat >> %LOG% 2>&1
echo. >> %LOG%
echo =============== PRISMA MIGRATE STATUS =============== >> %LOG%
call pnpm exec prisma migrate status >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [4/5] typecheck + lint ...
echo =============== TYPECHECK =============== >> %LOG%
call pnpm typecheck >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo =============== LINT =============== >> %LOG%
call pnpm lint >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [5/5] tests ... (this is the long one, several minutes)
echo =============== TEST =============== >> %LOG%
call pnpm test >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo === done === >> %LOG%
echo.
echo   Done. Results are in agent-report.log
echo   Leave the OTHER window (the stack) running.
echo.
pause
