# Rex AI launcher - PowerShell 7
$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

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

$bridge = Join-Path $ProjectDir "terminal_bridge.py"
if (-not (Test-Path $bridge)) { throw "terminal_bridge.py was not found." }

Write-Host "[3/4] Starting Rex local bridge..."
$bridgeProcess = Start-Process -FilePath $venvPython -ArgumentList @($bridge) -WorkingDirectory $ProjectDir -PassThru
Start-Sleep -Milliseconds 900

$url = "http://localhost:8000/index.html"
Write-Host "[4/4] Opening $url"
Start-Process $url
Write-Host "Rex AI is running. Close this window to stop the bridge."

try { Wait-Process -Id $bridgeProcess.Id }
finally {
    if (-not $bridgeProcess.HasExited) { Stop-Process -Id $bridgeProcess.Id -Force -ErrorAction SilentlyContinue }
}
