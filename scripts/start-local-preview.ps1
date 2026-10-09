param(
    [switch]$NoBrowser,
    [ValidateRange(1024, 65535)][int]$FrontendPort = 5173,
    [ValidateRange(1024, 65535)][int]$BackendPort = 8787,
    [ValidateRange(1, 600)][int]$StartupTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot '.runtime\preview'
$frontendUrl = "http://127.0.0.1:$FrontendPort/"
$backendUrl = "http://127.0.0.1:$BackendPort/api/health"

function ConvertTo-ShellLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-PreviewListener([int]$Port, [string]$Service) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $processId = $listener.OwningProcess
        $belongsToProject = $false
        $matchesService = $false
        for ($depth = 0; $depth -lt 10 -and $processId -gt 0; $depth++) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
            if (-not $process) { break }
            $command = ([string]$process.CommandLine).Replace('/', '\')
            if ($command.IndexOf($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $belongsToProject = $true
            }
            if ($Service -eq 'frontend' -and $command -match 'vite\\bin\\vite') { $matchesService = $true }
            if ($Service -eq 'backend' -and $command -match '(tsx\\dist|src\\server\.ts|dist\\server\.js)') {
                $matchesService = $true
            }
            $processId = $process.ParentProcessId
        }
        if (-not $belongsToProject -or -not $matchesService) {
            throw "Port $Port is occupied by another service (PID $($listener.OwningProcess)). Stop it or use a different preview port."
        }
    }
    return $listeners.Count -gt 0
}

function Test-PreviewReady([string]$Url, [string]$Service) {
    try {
        if ($Service -eq 'backend') {
            $health = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            return $health.ok -eq $true -and $health.service -eq 'kla-backend' -and $health.mode -eq 'postgres'
        }
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -eq 200 -and $response.Content.Contains('/@vite/client')
    } catch {
        return $false
    }
}

function Start-PreviewService([string]$Service, [string]$Filter, [string[]]$DevArguments) {
    $logFile = Join-Path $logDirectory "$Service.log"
    $environment = if ($Service -eq 'backend') {
        "`$env:HOST = '127.0.0.1'; `$env:PORT = '$BackendPort'; " +
        "Remove-Item Env:SUB2API_SHARED_ACCOUNT_EMAIL, Env:SUB2API_SHARED_ACCOUNT_PASSWORD -ErrorAction SilentlyContinue; " +
        "`$env:DOTENV_CONFIG_PATH = $(ConvertTo-ShellLiteral (Join-Path $projectRoot 'server\.env')); " +
        "`$env:DOTENV_CONFIG_OVERRIDE = 'true'; "
    } else {
        "`$env:VITE_API_BASE_URL = 'http://127.0.0.1:$BackendPort/api'; "
    }
    $quotedArguments = (@('--filter', $Filter, 'dev') + $DevArguments | ForEach-Object { ConvertTo-ShellLiteral $_ }) -join ' '
    $command = "Set-Location -LiteralPath $(ConvertTo-ShellLiteral $projectRoot); " +
        $environment + "& $(ConvertTo-ShellLiteral $pnpmPath) $quotedArguments *> $(ConvertTo-ShellLiteral $logFile); exit `$LASTEXITCODE"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @(
        '-NoLogo', '-NoProfile', '-EncodedCommand', $encoded
    )
    Write-Host "Starting $Service. Log: $logFile"
    return $process
}

function Wait-PreviewReady([string]$Url, [string]$Service, $Launcher) {
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-PreviewReady $Url $Service) { return }
        if ($Launcher -and $Launcher.HasExited) {
            throw "$Service exited during startup. Check $(Join-Path $logDirectory "$Service.log")."
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Service was not ready after $StartupTimeoutSeconds seconds. Check the service log and server/.env database configuration."
}

try {
    Set-Location -LiteralPath $projectRoot
    if ($FrontendPort -eq $BackendPort) { throw 'Frontend and backend must use different ports.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'pnpm-workspace.yaml'))) {
        throw 'Run this launcher from the KLA-2.0/kun-ai-chat project.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'server\.env'))) {
        throw 'server/.env is missing. Configure it using server/.env.example before starting the real database backend.'
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if (-not $nodeCommand -or -not $pnpmCommand) { throw 'Install Node.js 22+ and pnpm (corepack enable pnpm) first.' }
    $nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
    if ([int]($nodeVersion.Split('.')[0]) -lt 22) { throw 'Node.js 22 or newer is required.' }
    $pnpmPath = $pnpmCommand.Source

    # Check both ports before starting anything; never terminate unrelated services.
    $backendRunning = Get-PreviewListener $BackendPort 'backend'
    $frontendRunning = Get-PreviewListener $FrontendPort 'frontend'
    if (-not (Test-Path 'server\node_modules\.bin\tsx.cmd') -or
        -not (Test-Path 'apps\desktop\node_modules\.bin\vite.cmd') -or
        -not (Test-Path 'packages\contracts\node_modules\.bin\tsc.cmd')) {
        Write-Host 'Installing workspace dependencies from pnpm-lock.yaml...'
        & $pnpmPath install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }

    Write-Host "Project: $projectRoot"
    Write-Host 'Building the latest shared API contracts...'
    & $pnpmPath --filter @kla-workstation/contracts build
    if ($LASTEXITCODE -ne 0) { throw 'Shared API contract build failed.' }
    Write-Host 'Checking frontend and backend source before opening preview...'
    & $pnpmPath typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Source validation failed. Fix the reported errors before starting preview.' }
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

    $backendLauncher = $null
    if ($backendRunning) { Write-Host 'Reusing this project''s running backend.' }
    else { $backendLauncher = Start-PreviewService 'backend' '@kla-workstation/server' @() }
    Wait-PreviewReady $backendUrl 'backend' $backendLauncher

    $frontendLauncher = $null
    if ($frontendRunning) { Write-Host 'Reusing this project''s running frontend.' }
    else {
        $frontendLauncher = Start-PreviewService 'frontend' '@kla-workstation/desktop' @(
            '--host', '127.0.0.1', '--port', [string]$FrontendPort, '--strictPort'
        )
    }
    Wait-PreviewReady $frontendUrl 'frontend' $frontendLauncher

    Write-Host "Frontend ready: $frontendUrl"
    Write-Host "Backend ready: http://127.0.0.1:$BackendPort/api"
    Write-Host 'Services continue running after this launcher closes.'
    if (-not $NoBrowser) { Start-Process $frontendUrl }
    exit 0
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
