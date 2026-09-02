@echo off
rem Phase 11 (Q32): fetch the Rubik Arabic-subset woff2 pair into public\fonts\rubik\.
rem Double-click me once. Details in scripts\fetch-rubik.mjs.
cd /d "%~dp0.."
node scripts\fetch-rubik.mjs
pause
