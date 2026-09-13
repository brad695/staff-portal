@echo off
setlocal
REM ---------------------------------------------------------------------
REM  GREYS staff portal: sync this PC to GitHub, then push two changes.
REM
REM  WHY THIS EXISTS: this folder's copy of the repo is BEHIND
REM  github.com/brad695/staff-portal - the "New Case Entry" work (cheese
REM  plus wine/retail) is on GitHub but was never pulled back down here.
REM  A plain push would be refused, and forcing one would delete that work.
REM
REM  So this script pulls GitHub's copy down first, THEN drops in the two
REM  updated files that are sitting beside it:
REM     manager.new.html  -> manager.html   (Front Page editor)
REM     index.new.html    -> index.html     (Square future orders on the
REM                                          staff calendar)
REM  Both were rebuilt on top of GitHub's current copy, so nothing that is
REM  live today is lost.
REM ---------------------------------------------------------------------

cd /d "%~dp0"

if not exist ".git"            ( echo No git repo in this folder.        & pause & exit /b 1 )
if not exist "manager.new.html" ( echo manager.new.html is missing.       & pause & exit /b 1 )
if not exist "index.new.html"   ( echo index.new.html is missing.         & pause & exit /b 1 )
where git >nul 2>nul || ( echo Git is not installed or not on PATH.       & pause & exit /b 1 )

git config user.name  >nul 2>nul || git config user.name  "Brad"
git config user.email >nul 2>nul || git config user.email "bbearo@gmail.com"

echo.
echo [1/5] Clearing any stale git lock files...
for %%L in (".git\index.lock" ".git\HEAD.lock" ".git\config.lock" ".git\refs\heads\main.lock") do (
  if exist %%L del /f /q %%L
)

echo [2/5] Fetching from GitHub...
git fetch origin
if errorlevel 1 ( echo Fetch failed - check your connection or GitHub sign-in. & pause & exit /b 1 )

echo [3/5] Matching this folder to GitHub...
git reset --hard origin/main
if errorlevel 1 ( echo Reset failed. Stop here and check with Goose before pushing. & pause & exit /b 1 )

echo [4/5] Dropping in the two updated files...
move /y "manager.new.html" "manager.html" >nul || ( echo Could not replace manager.html. & pause & exit /b 1 )
move /y "index.new.html"   "index.html"   >nul || ( echo Could not replace index.html.   & pause & exit /b 1 )

echo [5/5] Committing and pushing...
git add -A
git diff --cached --quiet
if not errorlevel 1 ( echo Nothing to upload - GitHub already matches. & pause & exit /b 0 )

git commit -m "Front Page editor for the ticket site, and Square future orders on the portal calendar"
git push origin main
if errorlevel 1 (
  echo.
  echo Push failed - see the message above. Your commit is saved locally either way.
  pause
  exit /b 1
)

echo.
echo Done. Render redeploys the portal in a minute or two.
echo Then: Manager console - Tickets ^> Front Page.
pause
