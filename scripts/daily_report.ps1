$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) { $Python = "python" }

if ($env:GOOGLE_APPLICATION_CREDENTIALS -and
    (Test-Path -LiteralPath $env:GOOGLE_APPLICATION_CREDENTIALS)) {
    & $Python (Join-Path $Root "manage.py") collect-ga4 --days 365
}
& $Python (Join-Path $Root "manage.py") report
