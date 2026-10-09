@echo off
rem Windows: double-click to start the Northwind Gear demo shop. Close this window to stop it.
cd /d "%~dp0"
set PORT=5173
if not "%~1"=="" set PORT=%~1
where node >nul 2>nul
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 1 >nul & start http://localhost:%PORT%/"
  node server.mjs %PORT%
  goto :end
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 1 >nul & start http://localhost:%PORT%/"
  python server.py %PORT%
  goto :end
)
echo The demo shop needs Node.js (https://nodejs.org, LTS) or Python 3.
:end
pause
