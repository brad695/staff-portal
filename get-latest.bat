@echo off
setlocal
REM ==== GREYS staff portal: GET THE LATEST FROM GITHUB ====
REM Run this when you SIT DOWN, before you change anything.
REM It only DOWNLOADS. It never uploads, and it will stop rather than
REM overwrite work that is only on this computer.
REM   Sitting down  -> get-latest.bat        (this file)
REM   Finished      -> upload-to-github.bat  (saves + uploads)
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not in PATH.
  echo Install it from https://git-scm.com and run this again.
  pause
  exit /b 1
)

REM Clear lock files left behind by an interrupted git run
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\maintenance.lock" del /f /q ".git\maintenance.lock"

echo Checking GitHub for newer files...
echo.
git fetch origin
if errorlevel 1 (
  echo.
  echo Could not reach GitHub - check your internet / GitHub sign-in
  echo and run this again.
  pause
  exit /b 1
)

for /f %%i in ('git rev-parse HEAD') do set "BEFORE=%%i"
for /f %%i in ('git rev-parse origin/main') do set "REMOTE=%%i"

if "%BEFORE%"=="%REMOTE%" (
  echo This computer already matches GitHub - nothing to download.
  goto leftovers
)

REM Unsaved edits here? --ignore-cr-at-eol skips the Windows line-ending
REM noise that shows up as "modified" but is not a real change.
git diff --ignore-cr-at-eol --quiet HEAD
if errorlevel 1 goto dirty

REM Any commits here that GitHub does not have?
git merge-base --is-ancestor HEAD origin/main
if errorlevel 1 goto diverged

echo GitHub is newer. Updating this computer...
echo.
git merge --ff-only origin/main
if errorlevel 1 goto diverged

echo.
echo Files that changed:
echo ---------------------------------------------
git --no-pager diff --stat %BEFORE% HEAD
echo ---------------------------------------------
echo.
echo Done. This computer now matches GitHub.
goto leftovers

:dirty
echo.
echo *********************************************************
echo  STOPPED - nothing was downloaded.
echo.
echo  GitHub has newer files, but you have unsaved changes
echo  here that would be lost. Nothing is broken.
echo.
git --no-pager status --short
echo.
echo  Run upload-to-github.bat first - it saves your changes,
echo  combines them with GitHub's, and uploads. Then you are
echo  up to date and do not need to run this again.
echo *********************************************************
echo.
pause
exit /b 1

:diverged
echo.
echo *********************************************************
echo  STOPPED - nothing was downloaded.
echo.
echo  This computer has commits GitHub does not have, AND
echo  GitHub has commits this computer does not have.
echo  Nothing is broken and nothing is lost.
echo.
echo  Run upload-to-github.bat - it combines both sides safely.
echo  If it reports a conflict, screenshot it for Goose.
echo *********************************************************
echo.
pause
exit /b 1

:leftovers
echo.
git diff --ignore-cr-at-eol --quiet HEAD
if errorlevel 1 (
  echo NOTE - you have unsaved changes on this computer:
  git --no-pager status --short
  echo.
  echo Run upload-to-github.bat when you want them on GitHub.
  echo.
)
pause
