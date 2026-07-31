@echo off
setlocal
REM ── GREYS: one-time cleanup after the web-upload merge conflict ──
REM Clears the stuck merge, matches GitHub, then pushes the newest
REM manager.html (with Off / On call). Your files on disk are already
REM correct - this just makes git agree.
cd /d "%~dp0"

if exist ".git\index.lock" del /f /q ".git\index.lock"

REM keep scratch files out of the repo
findstr /x /l /c:"_stale/" .gitignore >nul 2>nul || echo _stale/>> .gitignore
findstr /x /l /c:"_to_delete/" .gitignore >nul 2>nul || echo _to_delete/>> .gitignore
findstr /x /l /c:"_sync_backup/" .gitignore >nul 2>nul || echo _sync_backup/>> .gitignore
findstr /x /l /c:"restore_*" .gitignore >nul 2>nul || echo restore_*>> .gitignore
findstr /x /l /c:"fix-sync.bat" .gitignore >nul 2>nul || echo fix-sync.bat>> .gitignore
findstr /x /l /c:"finish-sync.bat" .gitignore >nul 2>nul || echo finish-sync.bat>> .gitignore

echo [1/3] Clearing the stuck merge...
git rebase --abort 2>nul
git merge --abort 2>nul

echo [2/3] Matching GitHub history (your files on disk stay as they are)...
git fetch origin
if errorlevel 1 (
  echo Could not reach GitHub - check your internet and run this again.
  pause
  exit /b 1
)
git reset --mixed origin/main

echo [3/3] Uploading the newest manager console...
git add -A
git commit -m "manager console: off and on-call shift types"
git push -u origin main
if errorlevel 1 (
  echo.
  echo Push failed - screenshot this window and show Claude.
  pause
  exit /b 1
)

echo.
echo ================================================================
echo  Done! Everything is live once Render deploys (1-2 minutes).
echo  You can delete finish-sync.bat, fix-sync.bat, the restore_
echo  files and the _stale folder - git ignores them all now.
echo  Use upload-to-github.bat normally from here on.
echo ================================================================
pause
