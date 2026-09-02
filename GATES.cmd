@echo off
rem Runs the two fast quality gates (typecheck + lint) and writes gates.log.
rem The full test suite needs CI or a real PostgreSQL (embedded-postgres crashes
rem under concurrent connections on Windows) - see QA-CHECK.cmd and docs/DECISIONS.md.
cd /d "%~dp0"
echo === typecheck === > gates.log
call pnpm typecheck >> gates.log 2>&1
echo TYPECHECK_EXIT=%ERRORLEVEL% >> gates.log
echo === lint === >> gates.log
call pnpm lint >> gates.log 2>&1
echo LINT_EXIT=%ERRORLEVEL% >> gates.log
echo === done === >> gates.log
exit
