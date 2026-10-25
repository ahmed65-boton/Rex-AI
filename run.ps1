# Rex AI launcher - PowerShell 7
$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

# Build the browser bundle before starting the local server.
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $node -or -not $npm) {
    throw "Node.js and npm are required to build Rex AI. Install the current Node.js LTS release, then rerun run.ps1."
}

$esbuild = Join-Path $ProjectDir "node_modules\.bin\esbuild.cmd"
if (-not (Test-Path $esbuild)) {
    Write-Host "[0/4] Installing frontend build dependency (ESBuild)..."
    & $npm.Source install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed. Check your internet connection and npm configuration." }
}
Write-Host "[0/4] Building frontend with ESBuild..."
& $npm.Source run build
if ($LASTEXITCODE -ne 0) { throw "ESBuild failed. Rex AI was not started." }

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $python) { Write-Error "Python was not found. Install Python 3.10+ first."; exit 1 }

$venvDir = Join-Path $ProjectDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "[1/4] Creating Python environment..."
    if ($python.Name -eq "py.exe") { & $python.Source -3 -m venv $venvDir }
    else { & $python.Source -m venv $venvDir }
    if ($LASTEXITCODE -ne 0) { throw "Could not create .venv." }
} else { Write-Host "[1/4] Environment exists - skipping setup." }

$requirements = Join-Path $ProjectDir "requirements.txt"
$stamp = Join-Path $venvDir ".rex_requirements_hash"
if (Test-Path $requirements) {
    $hash = (Get-FileHash $requirements -Algorithm SHA256).Hash
    $oldHash = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { "" }
    if ($hash -ne $oldHash) {
        Write-Host "[2/4] Installing required Python modules..."
        & $venvPython -m pip install --disable-pip-version-check -r $requirements
        if ($LASTEXITCODE -ne 0) { throw "pip installation failed." }
        Set-Content -Path $stamp -Value $hash -NoNewline
    } else { Write-Host "[2/4] Modules up to date - skipping pip." }
}

$bridge = Join-Path $ProjectDir "server.py"
if (-not (Test-Path $bridge)) { throw "server.py was not found." }

Write-Host "[3/4] Starting Rex local bridge..."
& $venvPython $bridge
