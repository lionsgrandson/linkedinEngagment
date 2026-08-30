@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "ROOT=%~dp0"
set "EXTENSION=%ROOT%chrome_extension"
set "MODEL=qwen3.5:9b"
set "READY_MARKER=%ROOT%.codecrafter_extension_ready"

if /I "%~1"=="setup" del /q "%READY_MARKER%" >nul 2>&1
if /I "%~1"=="install-startup" goto install_startup

cls
echo ============================================================
echo              CODECRAFTER SOCIAL AUTOMATION
echo ============================================================
echo.

if not exist "%EXTENSION%\manifest.json" (
  echo [ERROR] Chrome extension was not found:
  echo         %EXTENSION%
  pause
  exit /b 1
)

where ollama >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Ollama is not installed or is not in PATH.
  echo Install Ollama, then run this file again.
  echo https://ollama.com/download/windows
  pause
  exit /b 1
)

echo [1/5] Starting Ollama if needed...
set "OLLAMA_READY=0"

rem The Ollama CLI uses the same local server as the browser extension.
rem On some Windows systems PowerShell Invoke-RestMethod can fail even while Ollama is healthy,
rem so use a successful CLI request as the primary readiness check.
ollama list >nul 2>&1
if not errorlevel 1 set "OLLAMA_READY=1"

if "%OLLAMA_READY%"=="0" (
  start "CodeCrafter Ollama" /min ollama serve
  for /L %%I in (1,1,30) do (
    timeout /t 1 /nobreak >nul
    ollama list >nul 2>&1
    if not errorlevel 1 (
      set "OLLAMA_READY=1"
      goto ollama_ready
    )
  )
)

:ollama_ready
if not "%OLLAMA_READY%"=="1" (
  echo [ERROR] Ollama did not become ready.
  echo.
  echo Try this command in another CMD window:
  echo   ollama list
  echo.
  echo If that command works, run this launcher again.
  pause
  exit /b 1
)
echo       Ollama is ready.

echo [2/5] Checking local model %MODEL%...
ollama list 2>nul | findstr /I /C:"%MODEL%" >nul
if errorlevel 1 (
  echo       Model is missing. Downloading %MODEL% now...
  ollama pull %MODEL%
  if errorlevel 1 (
    echo [ERROR] Could not install %MODEL%.
    pause
    exit /b 1
  )
) else (
  echo       Model is installed.
)

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME (
  echo [ERROR] Google Chrome was not found.
  pause
  exit /b 1
)

echo [3/5] Checking extension setup...
if not exist "%READY_MARKER%" (
  echo.
  echo FIRST RUN ONLY
  echo Chrome does not allow a script to silently install an unpacked extension.
  echo I opened chrome://extensions and copied the extension folder to your clipboard.
  echo.
  echo 1. Turn on Developer mode.
  echo 2. Click Load unpacked.
  echo 3. Paste this folder path:
  echo    %EXTENSION%
  echo 4. Make sure CodeCrafter Social Bridge is enabled.
  echo 5. Then come back here and press any key.
  echo.
  echo %EXTENSION%| clip
  start "" "%CHROME%" "chrome://extensions/"
  explorer.exe "%EXTENSION%"
  pause
  >"%READY_MARKER%" echo Extension setup acknowledged on %date% %time%
) else (
  echo       Extension setup was already completed.
)

echo [4/5] Opening LinkedIn feed...
start "" "%CHROME%" "https://www.linkedin.com/feed/"
echo       Message, notification, invitation and WhatsApp tabs are owned by the extension.
echo       This avoids multiple automation tabs trying to process the same conversation.

echo [5/5] Running.
echo.
echo The extension talks directly to Ollama. Python is not required for normal live use.
echo LinkedIn comments, comment-thread replies, connection requests, incoming invitations,
echo LinkedIn inbox replies, and WhatsApp replies are handled in the browser.
echo.
echo If an inbox is not open, use the extension Settings page and click Run Messages once.
echo WhatsApp replies always disclose that the reply is automated and that Moshe will follow up.
echo Business facts and writing style come from the extension Settings page.
echo.
echo If you changed extension code, open chrome://extensions, click Reload, and refresh the site tabs.
echo To redo extension setup, run:
echo   start_social_bot.cmd setup
echo To launch this automatically at Windows sign-in, run once:
echo   start_social_bot.cmd install-startup
echo.
exit /b 0

:install_startup
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "CodeCrafter Social Automation" /t REG_SZ /d "\"%~f0\"" /f >nul
if errorlevel 1 (
  echo [ERROR] Could not add the Windows startup entry.
  pause
  exit /b 1
)
echo CodeCrafter Social Automation will start at Windows sign-in.
pause
exit /b 0
