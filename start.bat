@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
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
