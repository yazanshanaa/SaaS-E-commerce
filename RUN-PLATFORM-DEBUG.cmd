@echo off
rem ============================================================================
rem  Souq Bartaa - DIAGNOSTIC launch. Same as RUN-PLATFORM.cmd but every line of
rem  output is written to run-platform.log so it can be inspected after the fact.
rem  The console window will look quiet on purpose - the output is in the log.
rem  DO NOT CLOSE this window; press Ctrl+C only when you want to stop the site.
rem ============================================================================
setlocal
cd /d "%~dp0"
title Souq Bartaa - DEBUG (writing run-platform.log)
del "%~dp0run-platform.log" 2>nul
echo === launching %date% %time% ===> "%~dp0run-platform.log"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-native.ps1" >> "%~dp0run-platform.log" 2>&1
echo === powershell exited with code %errorlevel% ===>> "%~dp0run-platform.log"
echo.
echo Finished. See run-platform.log. This window can be closed now.
pause
endlocal
