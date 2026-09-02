@echo off
REM ===========================================================================
REM  Close GHSA-ggr8-5vv4-36mx (deepmerge-ts stack exhaustion) and prove it.
REM
REM  WHY AN OVERRIDE RATHER THAN AN UPGRADE. `prisma` and `@prisma/client` are
REM  pinned to an exact 6.19.3 - no caret - so `pnpm up` moves nothing, and
REM  `pnpm up --latest` jumps to Prisma 7, which removes the `package.json#prisma`
REM  config block this repo still uses (Prisma already warns about it on every
REM  `migrate status`). That is a migration, not a security patch, and it does not
REM  belong in the same change as an advisory fix.
REM
REM  So the transitive dependency is pinned instead:
REM      pnpm.overrides: { "deepmerge-ts": ">=8.0.0" }
REM  reaching .>@prisma/client>prisma>@prisma/config>deepmerge-ts.
REM
REM  THE RISK IS REAL AND IS WHY THIS SCRIPT VERIFIES RATHER THAN ASSUMES:
REM  forcing a major version on a dependency Prisma pinned itself could break
REM  Prisma's config loader. So this runs the audit AND db:generate AND typecheck
REM  after the install. If any of them go red, revert the `overrides` block in
REM  package.json and say so - a closed advisory that breaks the client is worse
REM  than an open advisory with a written reachability note.
REM
REM  Unattended. Writes advisory.log; last line is ADVISORY-COMPLETE.
REM ===========================================================================

cd /d "%~dp0"
set LOG=advisory.log

echo Souq Bartaa advisory fix - %DATE% %TIME% > %LOG%
echo. >> %LOG%

echo   [1/5] audit BEFORE ...
echo =============== AUDIT BEFORE =============== >> %LOG%
call pnpm audit --audit-level high --prod >> %LOG% 2>&1
echo BEFORE_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [2/5] install with the override (rewrites pnpm-lock.yaml) ...
echo =============== INSTALL =============== >> %LOG%
call pnpm install --no-frozen-lockfile >> %LOG% 2>&1
echo INSTALL_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [3/5] audit AFTER ...
echo =============== AUDIT AFTER =============== >> %LOG%
call pnpm audit --audit-level high --prod >> %LOG% 2>&1
echo AFTER_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [4/5] does the Prisma client still generate? ...
echo =============== DB:GENERATE =============== >> %LOG%
call pnpm db:generate >> %LOG% 2>&1
echo GENERATE_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [5/5] typecheck ...
echo =============== TYPECHECK =============== >> %LOG%
call pnpm typecheck >> %LOG% 2>&1
echo TYPECHECK_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo =============== WHAT MOVED IN THE LOCKFILE =============== >> %LOG%
call git diff --stat pnpm-lock.yaml package.json >> %LOG% 2>&1
echo. >> %LOG%

echo ADVISORY-COMPLETE >> %LOG%
echo.
echo   Done - advisory.log
