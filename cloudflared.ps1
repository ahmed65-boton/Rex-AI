# Rex AI Cloudflare Tunnel helper — Windows x64
$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $ProjectDir 'cloudflared.exe'
$Url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'

if (-not (Test-Path $Exe)) {
    Write-Host 'Downloading the latest Cloudflare cloudflared for Windows x64...'
    Invoke-WebRequest -Uri $Url -OutFile $Exe
}

& $Exe --version
Write-Host ''
Write-Host 'cloudflared is ready. Rex can start a temporary Quick Tunnel from its Remote access button.'
