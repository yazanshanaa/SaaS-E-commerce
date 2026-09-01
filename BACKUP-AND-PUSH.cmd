@echo off
REM ===========================================================================
REM  Back up Phases 8-11 and put them in front of CI.
REM
REM  The last commit here is "Phase 7 - final QA and deployment", 11 Aug.
REM  Everything since - Phase 8 (cart, checkout, coupons), Phase 9, Phase 10
REM  (backups screen, standalone bundle), Phase 11 (nine templates, the
REM  dashboard kit, dark mode), the panel theming, and FIVE database migrations
REM  - exists only on this disk.
REM
REM  Two reasons that outrank the deployment:
REM    1. one disk failure and eighteen days of work is gone;
REM    2. deploy.yml deploys from git (`git fetch` + `git checkout <sha>`).
REM       Uncommitted code is not deployable code - a deploy today would put
REM       Phase 7 on the server, three phases behind what was built.
REM
REM  Pushes to a BRANCH, not main. ci.yml triggers on pull_request, so the
REM  branch gets the full gate with no deploy attached and nothing on main at
REM  risk. Merge once it is green.
REM
REM  Runs unattended and writes push.log. The last line is PUSH-COMPLETE.
REM ===========================================================================

cd /d "%~dp0"
set LOG=push.log

echo Souq Bartaa backup-and-push - %DATE% %TIME% > %LOG%
echo. >> %LOG%

echo   [1/5] what is about to be committed ...
echo =============== STATUS BEFORE =============== >> %LOG%
call git status --porcelain >> %LOG% 2>&1
echo. >> %LOG%
echo =============== COUNT =============== >> %LOG%
call git status --porcelain 2>nul | find /c /v "" >> %LOG% 2>&1
echo. >> %LOG%

echo   [2/5] Rubik faces the tests expect on disk ...
echo =============== FETCH-RUBIK =============== >> %LOG%
call node scripts\fetch-rubik.mjs >> %LOG% 2>&1
echo FETCH_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [3/5] branch ...
echo =============== BRANCH =============== >> %LOG%
call git rev-parse --verify phase-8-11 >nul 2>&1
if errorlevel 1 (
  call git checkout -b phase-8-11 >> %LOG% 2>&1
) else (
  call git checkout phase-8-11 >> %LOG% 2>&1
)
echo BRANCH_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [4/5] commit ...
echo =============== ADD + COMMIT =============== >> %LOG%
call git add -A >> %LOG% 2>&1
call git commit -m "Phases 8-11: cart and checkout, nine templates, backups screen, dashboard kit" -m "Eighteen days of work, five migrations included, that had never left one disk. On a branch rather than main so CI reports before anything merges - and so the suite runs somewhere it can, which Windows cannot do (see GATES.cmd)." -m "Also carries three fixes for failures the suite had been hiding: a zod parser that rejected its own output (.optional -> .nullish, three sites), a CHECK constraint that forbade the backorder policy the code documents, and the CI minio KMS key that had stopped pnpm test from ever running. See deploy/CI-FINDINGS.md." >> %LOG% 2>&1
echo COMMIT_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo   [5/5] push ...
echo =============== PUSH =============== >> %LOG%
call git push -u origin phase-8-11 >> %LOG% 2>&1
echo PUSH_EXIT=%ERRORLEVEL% >> %LOG%
echo. >> %LOG%

echo =============== STATE AFTER =============== >> %LOG%
call git log --oneline -3 >> %LOG% 2>&1
call git status --branch --porcelain=v1 >> %LOG% 2>&1
echo. >> %LOG%

echo PUSH-COMPLETE >> %LOG%
echo.
echo   Done - push.log
