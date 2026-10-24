@echo off
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing for the first time, please wait...
  call npm install --no-audit --no-fund
)
node server.js --open
pause
