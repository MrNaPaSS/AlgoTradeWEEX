#requires -Version 5.0
<#
  AlgoTrade Pro - PowerShell installer

  Run from PowerShell:
      powershell -ExecutionPolicy Bypass -File .\install.ps1

  Or, if execution policy is already set:
      .\install.ps1
#>

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Pause-And-Exit {
    param([int]$Code = 0)
    Write-Host ''
    Write-Host 'Press any key to close...' -ForegroundColor Yellow
    try { [void][System.Console]::ReadKey($true) } catch { Read-Host | Out-Null }
    exit $Code
}

function Fail {
    param([string]$Message)
    Write-Host ''
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    Pause-And-Exit 1
}

Write-Host ''
Write-Host '=======================================' -ForegroundColor Cyan
Write-Host '  AlgoTrade Pro - installer' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "Working directory: $PSScriptRoot"
Write-Host ''

# --- 1. Node.js check -----------------------------------------------------
Write-Host '[1/5] Checking Node.js...' -ForegroundColor Green
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail 'Node.js not found in PATH. Install Node 18+ from https://nodejs.org'
}
$nodeVer = & node --version
Write-Host "       Node: $nodeVer"

$majorNode = [int](($nodeVer -replace '^v','') -split '\.' | Select-Object -First 1)
if ($majorNode -lt 18) {
    Fail "Node.js >= 18 required (found $nodeVer)"
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Fail 'npm not found in PATH. Reinstall Node.js.' }
$npmVer = & npm --version
Write-Host "       npm:  $npmVer"
Write-Host ''

# --- 2. Directories -------------------------------------------------------
Write-Host '[2/5] Creating runtime directories...' -ForegroundColor Green
foreach ($d in 'data','logs','reports') {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Host "       created: $d\"
    } else {
        Write-Host "       exists:  $d\"
    }
}
Write-Host ''

# --- 3. .env --------------------------------------------------------------
Write-Host '[3/5] Checking .env ...' -ForegroundColor Green
if (-not (Test-Path -LiteralPath '.env')) {
    if (Test-Path -LiteralPath '.env.example') {
        Copy-Item '.env.example' '.env'
        Write-Host '       .env created from .env.example' -ForegroundColor Yellow
        Write-Host '       [!] Edit .env with real WEEX/Telegram/OpenRouter keys before first run.' -ForegroundColor Yellow
    } else {
        Fail 'Neither .env nor .env.example exists.'
    }
} else {
    Write-Host '       .env exists'
}
Write-Host ''

# --- 4. npm install -------------------------------------------------------
Write-Host '[4/5] Installing dependencies (may take several minutes)...' -ForegroundColor Green
$installCmd = if (Test-Path -LiteralPath 'package-lock.json') { 'ci' } else { 'install' }
Write-Host "       running: npm $installCmd"

# Use Start-Process so we don't swallow npm's exit code through pipeline quirks.
& npm $installCmd --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Fail "npm $installCmd failed with exit code $LASTEXITCODE"
}
Write-Host ''

# --- 5. Config validation -------------------------------------------------
Write-Host '[5/5] Validating config schema...' -ForegroundColor Green
& node -e "require('./src/config/config'); console.log('       config OK')"
if ($LASTEXITCODE -ne 0) {
    Fail 'config validation failed - check .env values above'
}
Write-Host ''

Write-Host '=======================================' -ForegroundColor Cyan
Write-Host '  Install complete.' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Start the bot:   npm start'
Write-Host '  Run tests:       npm test'
Write-Host '  Backtest:        npm run backtest -- --symbol BTCUSDT --tf 1h'
Write-Host ''
Pause-And-Exit 0
