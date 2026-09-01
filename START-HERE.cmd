@echo off
REM ===========================================================================
REM  Souq Bartaa - run the site locally. Double-click this file.
REM ===========================================================================
REM
REM  This machine BLUE-SCREENS when Docker Desktop starts its WSL2 engine
REM  (bugcheck 0x7E - see scripts\dev-native.ts and restart-diagnosis.txt), so
REM  nothing here touches Docker. Instead:
REM
REM    postgres  runs embedded, inside the node process, data in .pgdata-dev
REM    redis     is skipped - every cache path degrades to the database
REM    mail      is captured in-process to .tmp\dev-mail.json
REM
REM  .env sets DOMAIN=localhost, and *.localhost resolves to 127.0.0.1 in every
REM  modern browser, so NO hosts-file editing and NO administrator rights are
REM  needed. That is why this runs scripts\dev-native.ts directly rather than
REM  through scripts\dev-native.ps1, which exists to write hosts entries and
REM  raises a UAC prompt to do it.
REM
REM  When it finishes starting, open:
REM
REM    http://admin.localhost:3000     owner panel
REM    http://app.localhost:3000       merchant dashboard
REM
REM    sign in:  admin@souqbartaa.test  /  ChangeMe!2026
REM
REM  http://localhost:3000 returns 404 on purpose - the platform picks its
REM  surface from the hostname.
REM
REM  Keep this window OPEN. Closing it stops the database and the site.
REM ===========================================================================

cd /d "%~dp0"

echo.
echo   Starting Souq Bartaa (no Docker). First run takes a few minutes.
echo.

call pnpm exec tsx scripts/dev-native.ts

echo.
echo   The stack has stopped.
pause
