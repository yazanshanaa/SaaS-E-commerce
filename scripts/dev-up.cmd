@echo off
REM Souq Bartaa - start the development stack.
REM
REM Double-click this file, or run it from any terminal:
REM
REM     scripts\dev-up.cmd
REM
REM It exists so nobody has to remember PowerShell's execution-policy flag, and so the script is
REM launched with `powershell` (the 5.1 that ships with Windows) rather than `pwsh` (PowerShell 7,
REM which is a separate download and is what the first version of this wrongly assumed).

cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev-up.ps1"

REM Keep the window open when double-clicked, so an error message can actually be read.
if %ERRORLEVEL% NEQ 0 pause
