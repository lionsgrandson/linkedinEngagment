@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo [Opportunity Hunter] Node.js/npm is not installed.
  echo Install Node.js 18 or newer once, then run this file again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

call npm run start
set "EXIT_CODE=%errorlevel%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Opportunity Hunter could not start. Review the error above.
  pause
)

exit /b %EXIT_CODE%
