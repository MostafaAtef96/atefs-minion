@echo off
rem Run Atef's Minion from this folder without "npm link": minion run --notes "notes.md" --repo owner/name
node "%~dp0dist\cli\index.js" %*
