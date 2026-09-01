@echo off
rem Souq Bartaa - double-click launcher for the local (no-Docker) dev stack.
rem DOMAIN=localhost in .env, so *.localhost resolves on its own: no hosts file, no UAC.
rem Runs scripts\dev-native.ts: embedded postgres + prisma generate/migrate/seed + next dev.
title Souq Bartaa - local dev
cd /d "%~dp0"
call pnpm exec tsx scripts/dev-native.ts
echo.
echo ==== the stack stopped (exit %ERRORLEVEL%) ====
pause
