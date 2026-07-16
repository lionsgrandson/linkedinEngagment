$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
    throw "Create the project virtual environment first: python -m venv .venv"
}

$Version = (& $Python -c "import json; print(json.load(open('chrome_extension/manifest.json'))['version'])").Trim()
$PackageRoot = Join-Path $Root "dist\CodeCrafter-Client-$Version"
$ExtensionTarget = Join-Path $PackageRoot "chrome_extension"
$ExeTarget = Join-Path $PackageRoot "CodeCrafterSocialBridge.exe"
$StrategyData = "$(Join-Path $Root 'linkedin_strategy.json');."

& $Python -m pip install "pyinstaller==6.21.0"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller installation failed with exit code $LASTEXITCODE" }
& $Python -m PyInstaller --noconfirm --clean --onefile --name CodeCrafterSocialBridge `
    --distpath (Join-Path $Root "dist\bridge") `
    --workpath (Join-Path $Root "build\pyinstaller\$Version") `
    --specpath (Join-Path $Root "build") `
    --add-data $StrategyData `
    (Join-Path $Root "linkedin_bot.py")
if ($LASTEXITCODE -ne 0) { throw "Executable build failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Force -Path $PackageRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $Root "dist\bridge\CodeCrafterSocialBridge.exe") -Destination $ExeTarget -Force
Copy-Item -LiteralPath (Join-Path $Root "chrome_extension") -Destination $ExtensionTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Root "CLIENT_SETUP.md") -Destination (Join-Path $PackageRoot "CLIENT_SETUP.md") -Force

$ZipPath = Join-Path $Root "dist\CodeCrafter-Client-$Version.zip"
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
Compress-Archive -LiteralPath $PackageRoot -DestinationPath $ZipPath -CompressionLevel Optimal
Write-Output "Created portable Windows client package: $ZipPath"
