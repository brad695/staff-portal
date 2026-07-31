@echo off
setlocal
REM ── GREYS staff portal: one-click upload to GitHub ──
REM Pushes this folder to github.com/brad695/staff-portal (main branch).
REM Render auto-deploys the live site from that repo after each push.
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not in PATH. Install it from https://git-scm.com and run this again.
  pause
  exit /b 1
)

if not exist ".git" (
  echo First run - connecting this folder to the GitHub repo...
  git init -b main
  git remote add origin https://github.com/brad695/staff-portal.git
  git fetch origin
  git reset --mixed origin/main
  echo Connected. Your local files are kept; only the differences will be committed.
  echo.
)

echo Changed files:
echo ---------------------------------------------
git status --short
echo ---------------------------------------------
echo.

set "msg="
set /p msg="Commit message (press Enter for 'site update'): "
if "%msg%"=="" set "msg=site update"

git add -A
git commit -m "%msg%"
git push -u origin main

echo.
echo Done. Render will auto-deploy the live site in a minute or two.
pause
