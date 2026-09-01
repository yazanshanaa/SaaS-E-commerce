@echo off
REM ===========================================================================
REM  Souq Bartaa - QA sweep. Double-click, then send me qa-report.log
REM ===========================================================================
REM
REM  Runs the three checks that have never run against the Phase 10 code:
REM
REM    1. typecheck  - the whole tree at once. `next dev` compiles lazily, so a
REM                    page nobody opened is a page nobody has compiled.
REM    2. lint       - the architectural guardrails live here too.
REM    3. unit+integration tests - 1000+ assertions incl. the tenant-isolation
REM                    regressions and the new Phase 10 classification guard.
REM
REM  Everything lands in qa-report.log. Each section records its own exit code,
REM  and the run CONTINUES after a failure so one broken check does not hide
REM  the other two.
REM
REM  Safe to run while START-HERE.cmd is up: typecheck and lint touch no
REM  database, and the test suite boots its own private cluster.
REM ===========================================================================

cd /d "%~dp0"
set LOG=qa-report.log

REM ---------------------------------------------------------------------------
REM  The test harness boots its own Postgres on 55432 (tests/setup/postgres-harness.ts).
REM  On THIS machine that bind fails with "Permission denied" before Postgres even
REM  starts listening:
REM
REM    could not bind IPv4 address "127.0.0.1": Permission denied
REM    FATAL: could not create any TCP/IP sockets
REM
REM  That is not a busy port - it is Hyper-V/WSL reserving whole TCP ranges for
REM  itself (the same virtualization stack that bugchecks this box under Docker).
REM  Anything inside a reserved range is refused to every other process, so the
REM  suite could never start and reported "No test files found" instead.
REM
REM  5433 sits just above the dev cluster's 5432, well below the reserved blocks.
REM  Check the ranges yourself with:
REM    netsh interface ipv4 show excludedportrange protocol=tcp
REM ---------------------------------------------------------------------------
set EMBEDDED_PG_PORT=5433

echo Souq Bartaa QA sweep - %DATE% %TIME% > %LOG%
echo. >> %LOG%

echo.
echo   [1/3] typecheck ...
echo =============== TYPECHECK =============== >> %LOG%
call pnpm typecheck >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [2/3] lint ...
echo =============== LINT =============== >> %LOG%
call pnpm lint >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [3/3] tests ... (this is the long one)
echo =============== TEST =============== >> %LOG%
call pnpm test >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo.
echo   Done. Results are in qa-report.log
echo.
pause
