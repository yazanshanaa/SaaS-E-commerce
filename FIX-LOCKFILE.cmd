@echo off
REM ===========================================================================
REM  Refresh pnpm-lock.yaml after a `pnpm.overrides` change, and prove the
REM  audit is clean.
REM
REM  WHY THIS EXISTS. CI's dependency scan runs
REM
REM    pnpm install --frozen-lockfile
REM    pnpm audit --audit-level high --prod
REM
REM  and the first of those FAILS if package.json and pnpm-lock.yaml disagree.
REM  So adding an override is always two steps: edit the manifest, then
REM  regenerate the lock. Editing only the manifest turns one red check into a
REM  different red check, which is worse than leaving it alone - the second
REM  failure looks like a lockfile problem rather than the security fix it is.
REM
REM  2026-09-07: PR #3's scan reported FOUR high advisories, all of them the
REM  same package - `fast-uri`, patched in >=3.1.6, all reached through
REM  `@sentry/nextjs > @sentry/webpack-plugin > webpack > schema-utils > ajv`.
REM  Pinned with an override rather than by moving Sentry, following the
REM  precedent already in this file for `deepmerge-ts` (GHSA-ggr8-5vv4-36mx):
REM  a transitive advisory is fixed at the transitive dependency, not by
REM  dragging a major version of something else through the whole tree.
REM
REM  Safe to run any time. It changes pnpm-lock.yaml and nothing else.
REM ===========================================================================

cd /d "%~dp0"
set LOG=lockfile.log

echo Souq Bartaa lockfile refresh - %DATE% %TIME% > %LOG%
echo. >> %LOG%

echo.
echo   [1/3] installing (this rewrites pnpm-lock.yaml from package.json) ...
echo =============== INSTALL =============== >> %LOG%
call pnpm install >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [2/3] the audit CI actually runs ...
echo =============== AUDIT (high and above - this is the CI gate) =============== >> %LOG%
call pnpm audit --audit-level high --prod >> %LOG% 2>&1
echo EXITCODE=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [3/3] what changed ...
echo =============== GIT STATUS =============== >> %LOG%
call git status --porcelain >> %LOG% 2>&1
echo. >> %LOG%

echo === done === >> %LOG%
echo.
echo   Done. Results are in lockfile.log
echo.
echo   EXITCODE=0 on the AUDIT section means the CI check will now pass.
echo   Then run BACKUP-AND-PUSH.cmd to send the fix to the branch.
echo.
pause
exit /b 0
