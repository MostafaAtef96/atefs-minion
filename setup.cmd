@echo off
rem Atef's Minion: double-click to install (first time only) and open the web page.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing Atef's Minion, this happens only once...
  call npm ci || goto :failed
)
call npm run build --silent || goto :failed
echo.
echo Opening Atef's Minion in your browser. Keep this window open while you use it.
node "%~dp0dist\cli\index.js" web --open
pause
exit /b 0
:failed
echo.
echo Setup failed. See the messages above (on company laptops this is often the npm proxy or registry setting).
pause
exit /b 1
