@echo off
REM ===========================================================================
REM  Souq Bartaa - read-only probe. Double-click and walk away.
REM
REM  Changes NOTHING: no install, no generate, no stack, no git write. It reads
REM  the tree, runs typecheck and lint, and writes agent-probe.log.
REM
REM  Deliberately does not start START-HERE.cmd the way AGENT-RUN.cmd does - a
REM  typecheck needs no database, and a second window holding port 5432 is a
REM  side effect nobody asked for.
REM
REM  The last line of the log is PROBE-COMPLETE. If it is missing, the run is
REM  still going.
REM ===========================================================================

cd /d "%~dp0"
set LOG=agent-probe.log

echo Souq Bartaa probe - %DATE% %TIME% > %LOG%
echo. >> %LOG%

echo   [1/5] git state ...
echo =============== GIT BRANCH + STATUS =============== >> %LOG%
call git status --branch --porcelain=v1 >> %LOG% 2>&1
echo. >> %LOG%

echo =============== GIT LOG (last 5) =============== >> %LOG%
call git log --oneline -5 >> %LOG% 2>&1
echo. >> %LOG%

echo   [2/5] how much is uncommitted ...
echo =============== UNCOMMITTED FILE COUNT =============== >> %LOG%
call git status --porcelain 2>nul | find /c /v "" >> %LOG% 2>&1
echo. >> %LOG%

echo   [3/5] toolchain versions ...
echo =============== VERSIONS =============== >> %LOG%
call node --version >> %LOG% 2>&1
call pnpm --version >> %LOG% 2>&1
echo. >> %LOG%

echo   [4/5] typecheck ... (a minute or two)
echo =============== TYPECHECK =============== >> %LOG%
call pnpm typecheck >> %LOG% 2>&1
echo TYPECHECK_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [5/5] lint ...
echo =============== LINT =============== >> %LOG%
call pnpm lint >> %LOG% 2>&1
echo LINT_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo PROBE-COMPLETE >> %LOG%
echo.
echo   Done - agent-probe.log
