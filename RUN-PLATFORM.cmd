@echo off
rem ============================================================================
rem  Souq Bartaa - one-click local launch (NO Docker / NO WSL2).
rem  Double-click this file. It runs scripts\dev-native.ps1, which brings up
rem  postgres (embedded) + migrate + seed + next dev in this window.
rem  Windows may ask for admin ONCE - only to add the local hostnames to the
rem  hosts file. Click "Yes". Nothing else is elevated.
rem  Keep this window open while you use the site. Press Ctrl+C to stop.
rem ============================================================================
setlocal
cd /d "%~dp0"
title Souq Bartaa - Local (no Docker)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-native.ps1"
if errorlevel 1 (
  echo.
  echo [x] The launcher exited with an error. Read the messages above.
  pause
)
endlocal
