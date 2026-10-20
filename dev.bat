@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Starting MyLens dev servers...
echo API: http://127.0.0.1:8787
echo UI:  http://127.0.0.1:5174
start "" cmd /c "timeout /t 4 >nul & start http://127.0.0.1:5174"
call npm run dev
