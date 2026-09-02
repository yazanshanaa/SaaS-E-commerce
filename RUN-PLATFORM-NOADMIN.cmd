@echo off
rem ============================================================================
rem  Souq Bartaa - NO-ADMIN local launch (no Docker, no hosts file, no UAC).
rem  Runs the platform on *.localhost, which every browser resolves to 127.0.0.1
rem  automatically - so no administrator prompt is ever needed.
rem
rem    Super admin : http://admin.localhost:3000
rem    Merchant    : http://app.localhost:3000
rem    Login       : admin@souqbartaa.test  /  ChangeMe!2026
rem
rem  This launcher first frees ports 3000 (web) and 5432 (db) by stopping any
rem  previous instance, so it is safe to run again if a run got stuck.
rem  Output goes to run-platform.log. Keep this window open; Ctrl+C stops it.
rem ============================================================================
setlocal
cd /d "%~dp0"

echo Freeing ports 3000 and 5432 from any previous run...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5432"') do taskkill /F /PID %%a >nul 2>&1

set "DOMAIN=localhost"
set "BETTER_AUTH_URL=http://app.localhost:3000"
set "PUBLIC_SCHEME=http"
title Souq Bartaa - Local (no admin, *.localhost)
del "%~dp0run-platform.log" 2>nul
echo === launching NOADMIN %date% %time% ===> "%~dp0run-platform.log"
call pnpm exec tsx "%~dp0scripts\dev-native.ts" >> "%~dp0run-platform.log" 2>&1
echo === tsx exited with code %errorlevel% ===>> "%~dp0run-platform.log"
echo.
echo Finished. See run-platform.log. This window can be closed now.
pause
endlocal
