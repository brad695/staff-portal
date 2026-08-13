@echo off
setlocal
REM ── GREYS staff portal: sync this PC to GitHub, then push the catering buttons ──
REM
REM This PC's copy of the repo is BEHIND github.com/brad695/staff-portal.
REM Pushing from here as-is would revert the live site. This script fixes that:
REM   1. pulls down the current repo from GitHub (discarding this PC's stale copy)
REM   2. drops in the updated manager.html (catering quick-add buttons)
REM   3. commits and pushes, which triggers the Render deploy
REM
REM Nothing on this PC is lost: the only local "changes" were line-ending churn,
REM not real edits. Verified before this script was written.

cd /d "C:\Projects\staff-portal-main"
if not exist ".git" (
  echo No git repo found at C:\Projects\staff-portal-main
  pause
  exit /b 1
)
if not exist "manager.new.html" (
  echo manager.new.html is missing - it should be sitting in this folder.
  pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not in PATH. Install it from https://git-scm.com and run this again.
  pause
  exit /b 1
)

git config user.name >nul 2>nul || git config user.name "Brad"
git config user.email >nul 2>nul || git config user.email "bbearo@gmail.com"

echo.
echo [1/4] Fetching the current repo from GitHub...
git fetch origin
if errorlevel 1 (
  echo Fetch failed. Check your internet connection / GitHub sign-in and try again.
  pause
  exit /b 1
)

echo [2/4] Resetting this folder to match GitHub...
git reset --hard origin/main
if errorlevel 1 (
  echo Reset failed. Stop here and check with Claude before pushing.
  pause
  exit /b 1
)

echo [3/4] Dropping in the updated manager.html...
move /y "manager.new.html" "manager.html" >nul
if errorlevel 1 (
  echo Could not replace manager.html.
  pause
  exit /b 1
)

echo [4/4] Committing and pushing...
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo Nothing to upload - manager.html already matches GitHub.
  pause
  exit /b 0
)

git commit -m "Catering pre-orders: quick-add buttons from the Square catering categories"
git push origin main
if errorlevel 1 (
  echo.
  echo Push failed. If a GitHub sign-in window opened, finish signing in and run this again.
  pause
  exit /b 1
)

echo.
echo Done. Render will redeploy the portal in a minute or two.
echo Open the manager portal, go to Catering ^> Pre-Orders, and the button grid
echo should be sitting above the search box.
pause
