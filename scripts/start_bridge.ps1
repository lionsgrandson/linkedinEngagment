$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) { $Python = "python" }

$BridgeReady = Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue
if (-not $BridgeReady) {
    Start-Process -FilePath $Python -ArgumentList 'linkedin_bot.py' -WorkingDirectory $Root -WindowStyle Hidden
}

$OllamaReady = Get-NetTCPConnection -State Listen -LocalPort 11434 -ErrorAction SilentlyContinue
if (-not $OllamaReady -and (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WorkingDirectory $Root -WindowStyle Hidden
}
