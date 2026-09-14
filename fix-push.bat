@echo off
setlocal
REM One-time fix: point git at the Windows copy of the credentials file, then push.
cd /d "%~dp0"

if exist ".git\index.lock" del /f /q ".git\index.lock"

echo Pointing git at the Windows credentials file...
git config credential.helper "store --file=C:/Users/bbear/Claude/Projects/.git-credentials"

echo.
echo Current state:
git status -sb
echo.

echo Pushing to GitHub...
git push origin main
if errorlevel 1 (
  echo.
  echo ***** PUSH FAILED - copy everything above and show Claude. *****
  pause
  exit /b 1
)

echo.
echo Pushed. Render will redeploy in a minute or two.
pause
