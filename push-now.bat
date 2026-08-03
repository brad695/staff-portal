@echo off
cd /d "%~dp0"
echo Uploading your saved changes to GitHub...
echo.
git push -u origin main
echo.
echo (exit code: %errorlevel%)
echo.
echo If it says "Everything up-to-date" or shows main -^> main, it worked.
echo Otherwise, screenshot this whole window for Goose.
pause
