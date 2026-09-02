@echo off
REM ===========================================================================
REM  START-HERE.cmd, with the output captured AND the stale engine lock cleared.
REM ===========================================================================
REM
REM  Runs exactly what START-HERE.cmd runs — `scripts/dev-native.ts`, no Docker,
REM  embedded postgres, no admin rights. Two differences, both diagnostic:
REM
REM  1. OUTPUT GOES TO dev-native.log as well as the screen, because a console
REM     window is unreadable to an agent driving this machine and "the stack did
REM     not start" is not a diagnosis.
REM
REM  2. It kills orphaned node.exe processes FIRST. `prisma generate` failed here
REM     with:
REM
REM       EPERM: operation not permitted, rename
REM         node_modules\.pnpm\@prisma+client@6.19.3_...\.prisma\client\
REM         query_engine-windows.dll.node.tmp151404 -> ...dll.node
REM
REM     which on Windows means one thing: another process still has the query
REM     engine DLL open, so Prisma cannot swap the new one in. Six full vitest
REM     runs on 2026-08-30/31 left workers behind holding it.
REM
REM     WHAT THIS DOES AND DOES NOT CLOSE. `node.exe` only. It does NOT close
REM     VS Code, Chrome, or Docker Desktop — those are Code.exe, chrome.exe and
REM     com.docker.*. VS Code's TypeScript/ESLint helpers ARE node.exe and will
REM     be killed, but VS Code respawns them within seconds and no unsaved work
REM     is touched. If you are deliberately running some other Node app (a
REM     different dev server, a script), close this and stop it yourself first.
REM ===========================================================================

cd /d "%~dp0"

echo.
echo   Clearing orphaned node.exe processes (they hold the Prisma engine DLL)...
taskkill /F /IM node.exe >nul 2>&1
if errorlevel 1 (
  echo   none were running.
) else (
  echo   done.
)

echo.
echo   Starting Souq Bartaa, logging to dev-native.log
echo   Keep this window open. Closing it stops the database and the site.
echo.

call pnpm exec tsx scripts/dev-native.ts > dev-native.log 2>&1

echo.
echo   The stack has stopped. See dev-native.log for what happened.
pause
