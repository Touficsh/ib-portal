# MT5 Bridge launcher — sets the env vars the bridge needs and starts it.
# Use this instead of double-clicking mt5-bridge.exe directly so the
# webhook secret and CRM backend URL are always populated.
#
# Usage:
#   pwsh C:\ib-portal\mt5-bridge\start-bridge.ps1
#   (or run from Task Scheduler / NSSM service to auto-start at boot)

$ErrorActionPreference = 'Stop'

# Resolve repo root from this script's location so the launcher works
# wherever the repo is cloned. PSScriptRoot is the directory of *this* file.
$repoRoot   = Split-Path -Parent $PSScriptRoot
$portalEnv  = Join-Path $repoRoot 'backend\.env'

# ── Webhook secret: pulled from backend/.env so we have ONE source of truth.
# The portal reads it from there too, so the bridge and portal can't drift.
# .env is gitignored, so secrets never land in the repo.
if (-not (Test-Path $portalEnv)) {
    throw "Portal .env not found at $portalEnv. Configure backend/.env first (see README.md)."
}
$secretLine = Get-Content $portalEnv | Where-Object { $_ -match '^MT5_WEBHOOK_SECRET=' } | Select-Object -First 1
if (-not $secretLine) {
    throw "MT5_WEBHOOK_SECRET not set in $portalEnv. Add it before starting the bridge."
}
$env:MT5_WEBHOOK_SECRET = ($secretLine -split '=', 2)[1].Trim()

# Where the bridge fetches MT5 manager credentials from
# (GET /api/settings/mt5/internal). Localhost = the IB Portal backend.
$env:CRM_BACKEND_URL = 'http://localhost:3001'

# Stop any existing bridge before launching a new one
$existing = Get-Process -Name 'mt5-bridge' -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing bridge (PID $($existing.Id))..."
    Stop-Process -Id $existing.Id -Force
    Start-Sleep -Seconds 2
}

# Bridge is built into bin/Release/net8.0-windows. Logs land in mt5-bridge/.
$bridgeDir = Join-Path $PSScriptRoot 'bin\Release\net8.0-windows'
$bridgeExe = Join-Path $bridgeDir 'mt5-bridge.exe'
$logOut    = Join-Path $PSScriptRoot 'bridge-run.log'
$logErr    = Join-Path $PSScriptRoot 'bridge-err.log'

if (-not (Test-Path $bridgeExe)) {
    throw "Bridge exe not found at $bridgeExe. Run 'dotnet build -c Release' in $PSScriptRoot first."
}

Start-Process -FilePath $bridgeExe `
              -WorkingDirectory $bridgeDir `
              -WindowStyle Hidden `
              -RedirectStandardOutput $logOut `
              -RedirectStandardError  $logErr

Start-Sleep -Seconds 5

try {
    $health = (Invoke-WebRequest -Uri 'http://localhost:5555/health' -TimeoutSec 5 -UseBasicParsing).Content
    Write-Host "Bridge started: $health"
} catch {
    Write-Warning "Bridge launched but /health didn't respond yet. Check $logOut"
}
