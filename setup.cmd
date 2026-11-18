@echo off
rem One-time setup after downloading Atef's Minion: installs the dependencies and builds it.
cd /d "%~dp0"
call npm ci || goto :failed
call npm run build || goto :failed
echo.
echo Setup finished. Next, in this folder:  minion run --notes "your-notes.md" --repo owner/name
pause
exit /b 0
:failed
echo.
echo Setup failed. See the messages above (on company laptops this is often the npm proxy or registry setting).
pause
exit /b 1
