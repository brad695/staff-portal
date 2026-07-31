@echo off
setlocal
REM ── GREYS staff portal: one-click sync with GitHub ──
REM Downloads the latest from github.com/brad695/staff-portal, then uploads
REM your changes. Render auto-deploys the live site after each push.
REM TIP: run this when you SIT DOWN (to get the other computer's changes)
REM and again when you FINISH (to upload yours). That keeps home + work in sync.
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not in PATH. Install it from https://git-scm.com and run this again.
  pause
  exit /b 1
)

REM Clear stale lock files left behind by an interrupted git run
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\maintenance.lock" del /f /q ".git\maintenance.lock"

REM Keep scratch / repair files out of the repo
findstr /x /l /c:"_stale/" .gitignore >nul 2>nul || echo _stale/>> .gitignore
findstr /x /l /c:"_to_delete/" .gitignore >nul 2>nul || echo _to_delete/>> .gitignore
findstr /x /l /c:"_sync_backup/" .gitignore >nul 2>nul || echo _sync_backup/>> .gitignore
findstr /x /l /c:"restore_*" .gitignore >nul 2>nul || echo restore_*>> .gitignore
findstr /x /l /c:"fix-sync.bat" .gitignore >nul 2>nul || echo fix-sync.bat>> .gitignore
git reset >nul 2>nul

echo Changed files on this computer:
echo ---------------------------------------------
git status --short
echo ---------------------------------------------
echo.

REM 1. Save local changes first (so nothing gets lost when we download)
git add -A
git diff --cached --quiet
if errorlevel 1 goto ask
echo No local changes to save - just syncing with GitHub...
goto pull

:ask
set "msg="
set /p msg="Commit message (press Enter for 'site update'): "
if "%msg%"=="" set "msg=site update"
git commit -m "%msg%"
if errorlevel 1 (
  echo.
  echo Could not save your changes - copy the messages above and show Claude.
  pause
  exit /b 1
)

:pull
REM 2. Download the other computer's changes and combine them
git pull --rebase origin main
if errorlevel 1 (
  echo.
  echo *********************************************************
  echo  Could not combine changes automatically.
  echo  Nothing is broken - copy the messages above and ask
  echo  Claude to sort it out. (If it mentions a conflict, both
  echo  computers changed the same file and one side must win.)
  echo *********************************************************
  pause
  exit /b 1
)

REM 3. Upload everything
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed - check your internet / GitHub sign-in and run this again.
  pause
  exit /b 1
)

echo.
echo Done. This computer now matches GitHub, and Render will
echo auto-deploy the live site in a minute or two.
pause
