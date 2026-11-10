@echo off
setlocal
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem start-mysql.bat — share MyLens on your WiFi with MySQL storage.
rem
rem Combines start-lan.bat (LAN sharing) with MYLENS_STORE=mysql:
rem every account's data (users, history, AI chats, practice, and the
rem per-user workspace) lives in a `mylens` schema on this machine's
rem MySQL server, so it survives restarts and follows accounts across
rem devices. The database and its tables are created automatically on
rem first boot; existing data/ JSON files are imported once.
rem ------------------------------------------------------------------

rem Node gate (same as start.bat): a clear error beats an opaque one.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node 20.19+ from https://nodejs.org
  exit /b 1
)
node -e "const [maj,min]=process.versions.node.split('.').map(Number); if(maj<20||(maj===20&&min<19)){console.error('MyLens needs Node 20.19+ (found '+process.versions.node+'). Install it from https://nodejs.org');process.exit(1)}"
if errorlevel 1 exit /b 1

rem Build the UI once if it has not been built yet.
if not exist dist\index.html (
  echo Building the UI...
  call npm run build
  if errorlevel 1 exit /b 1
)

rem Detect this machine's LAN IPv4: the interface with a default gateway.
set LAN_IP=
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress"`) do set LAN_IP=%%i
if "%LAN_IP%"=="" (
  echo Could not detect a LAN IPv4 address. Connect to the WiFi network and
  echo try again, or set MYLENS_HOST yourself before running this script.
  exit /b 1
)

rem MySQL storage: the app's own data lives in this MySQL server. Make sure
rem MySQL (XAMPP control panel) is running BEFORE starting this script.
rem Override the target with MYLENS_STORE_MYSQL_URI / _DATABASE if needed.
set MYLENS_HOST=%LAN_IP%
set MYLENS_ALLOW_REMOTE_HOST=1
set MYLENS_STORE=mysql

echo.
echo ================================================================
echo   MyLens is sharing on your WiFi with MySQL storage:
echo.
echo       http://%LAN_IP%:8787
echo.
echo   Storage database : mylens (auto-created on your MySQL server)
echo   Prerequisite     : MySQL running in the XAMPP control panel
echo.
echo   Classmates: open that address and sign in with the member
echo   account created on the Admin page. Their tabs, history and
echo   AI chats follow their account to any device.
echo.
echo   First launch: allow Node.js through the Windows firewall
echo   prompt. Keep this window open while sharing. Ctrl+C stops it.
echo ================================================================
echo.
call npm start
