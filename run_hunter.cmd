@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [Opportunity Hunter] Creating Python environment...
  py -3.11 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 goto :fail
)

echo [Opportunity Hunter] Installing/updating dependencies...
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
if errorlevel 1 goto :fail

start "CodeCrafter Opportunity Hunter" cmd /c "timeout /t 2 /nobreak >nul & start \"\" http://127.0.0.1:8770"
echo [Opportunity Hunter] Starting at http://127.0.0.1:8770
".venv\Scripts\python.exe" -m opportunity_hunter.server
exit /b %errorlevel%

:fail
echo.
echo Opportunity Hunter could not start. Review the error above.
pause
exit /b 1
