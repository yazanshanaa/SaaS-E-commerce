# Run the gates, commit the working tree, push the current branch.
#
#   powershell -ExecutionPolicy Bypass -File scripts\ship.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\ship.ps1 -SkipTests
#   powershell -ExecutionPolicy Bypass -File scripts\ship.ps1 -Message "..."
#
# WINDOWS POWERSHELL 5.1, not `pwsh`. `pwsh` is PowerShell 7 and is a separate install; the shell
# that ships with Windows is `powershell`. Everything below is written for 5.1 and works in 7 too,
# which is why it is ASCII-only: a 5.1 console reads a BOM-less script as Windows-1252, so a box-
# drawing character or a check mark in an output string arrives as mojibake.
#
# WHY THIS IS A SCRIPT AND NOT FOUR PASTED COMMANDS. Pasting them runs all four whichever way the
# first one goes: `pnpm typecheck` failing does not stop `git push` on the next line, because a
# native executable's non-zero exit is not a terminating error in PowerShell -- `$ErrorActionPreference`
# governs cmdlets, not `pnpm.exe`. A red typecheck would then sail through to the server and fail the
# docker build there instead, twenty minutes later, on the machine serving customers. Every step
# below checks `$LASTEXITCODE`.
#
# IT DOES NOT TOUCH THE SERVER. Pushing is where this stops. The deploy workflow
# (.github/workflows/deploy.yml) only fires on `main`, and this repo's production box is checked out
# to `phase-8-11` -- so the last step is `scripts/server-update.sh`, run over SSH. It is printed at
# the end rather than executed, because a script that can rebuild production should not be one you
# run by accident.

param(
  [string]$Message = "Rework the storefront header, the location and hours inputs, and the admin's own screens",
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Assert-Tool {
  param([string]$Name, [string]$Fix)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "[X] '$Name' is not on PATH." -ForegroundColor Red
    Write-Host "    $Fix" -ForegroundColor Yellow
    exit 1
  }
}

function Invoke-Step {
  param([string]$Label, [scriptblock]$Body)

  Write-Host ""
  Write-Host "== $Label" -ForegroundColor Cyan
  & $Body

  # The check that makes this a gate rather than a list. `pnpm` and `git` report failure through the
  # exit code only; without this the script would announce every step as done and push anyway.
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[X] $Label failed (exit $LASTEXITCODE). NOTHING WAS PUSHED." -ForegroundColor Red
    exit 1
  }
}

# Checked before anything runs, so a missing tool is one clear line rather than a stack trace four
# minutes into the test suite.
Assert-Tool 'git'  'Install Git for Windows, or reopen this terminal if you just installed it.'
if (-not $SkipTests) {
  Assert-Tool 'pnpm' 'Run:  corepack enable pnpm    (or:  npm install -g pnpm)'
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Write-Host ""
Write-Host "Repo:   $(Get-Location)" -ForegroundColor Yellow
Write-Host "Branch: $branch" -ForegroundColor Yellow

if (-not $SkipTests) {
  # Cheapest first, so the fastest failure is the one you wait for. `typecheck` catches the class of
  # mistake a large edit actually makes; `test` is the slowest and runs last.
  Invoke-Step "pnpm typecheck" { pnpm typecheck }
  Invoke-Step "pnpm lint"      { pnpm lint }
  Invoke-Step "pnpm test"      { pnpm test }
} else {
  Write-Host ""
  Write-Host "[!] -SkipTests: the gates did not run." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "== git add -A" -ForegroundColor Cyan
git add -A
if ($LASTEXITCODE -ne 0) { Write-Host "[X] git add failed." -ForegroundColor Red; exit 1 }

# `git diff --cached --quiet` exits 1 when there IS something staged -- the normal case here -- so it
# is asked as a question rather than run through Invoke-Step, which would read that as a failure.
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host "Nothing to commit; the working tree is already clean." -ForegroundColor Yellow
} else {
  # `--no-pager`, and it is not cosmetic: Git on Windows sends multi-screen output to `less`, which
  # waits at `(END)` for a keypress. Inside a script that is not a pause, it is a hang -- the run
  # stops between the file list and the commit with no prompt saying why, and the obvious reading
  # is that the script crashed. Nothing here is interactive, so nothing here should page.
  git --no-pager diff --cached --name-only
  Invoke-Step "git commit" { git commit -m $Message }
}

Invoke-Step "git push origin $branch" { git push origin $branch }

$sha = (git rev-parse --short HEAD).Trim()

Write-Host ""
Write-Host "[OK] Pushed $sha to origin/$branch" -ForegroundColor Green
Write-Host ""
Write-Host "The live site has NOT changed yet. The deploy workflow only watches 'main', and the"  -ForegroundColor Yellow
Write-Host "production box runs '$branch'. Run this on the server to pick it up:"                  -ForegroundColor Yellow
Write-Host ""
Write-Host "  ssh <user>@<your-vps>"                                        -ForegroundColor White
Write-Host "  cd /srv/souq-bartaa"                                          -ForegroundColor White
Write-Host "  git fetch --all --prune"                                      -ForegroundColor White
Write-Host "  git checkout $branch && git pull --ff-only"                   -ForegroundColor White
Write-Host "  bash scripts/server-update.sh"                                -ForegroundColor White
Write-Host ""
Write-Host "If it goes wrong, roll back to the commit before this one:"     -ForegroundColor Yellow
Write-Host "  git checkout --detach $sha~1 && docker compose -f docker-compose.prod.yml up -d --build" -ForegroundColor White
Write-Host ""
