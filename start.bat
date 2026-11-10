@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node 20.19+ from https://nodejs.org
  exit /b 1
)
node -e "const [maj,min]=process.versions.node.split('.').map(Number); if(maj<20||(maj===20&&min<19)){console.error('MyLens needs Node 20.19+ (found '+process.versions.node+'). Install it from https://nodejs.org');process.exit(1)}"
if errorlevel 1 exit /b 1

if not exist node_modules (
  echo Installing dependencies...
  call npm ci
  if errorlevel 1 exit /b 1
)

if not exist dist\index.html (
  echo Building the UI...
  call npm run build
  if errorlevel 1 exit /b 1
)

echo Starting MyLens at http://127.0.0.1:8787
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:8787"
call npm start
