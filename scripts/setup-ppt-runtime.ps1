param([string]$Python = 'python', [string]$RuntimeDirectory = (Join-Path $env:LOCALAPPDATA 'kla-workstation\ppt-runtime'))
$ErrorActionPreference = 'Stop'
$kit = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps\desktop\resources\skills\deck-agent-kit'
& $Python -m venv $RuntimeDirectory
if ($LASTEXITCODE -ne 0) { throw 'Unable to create Python virtual environment (Python 3.10+ required).' }
$exe = Join-Path $RuntimeDirectory 'Scripts\python.exe'
& $exe -m pip install -r (Join-Path $kit 'scripts\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'PPT dependencies installation failed.' }
& $exe -X utf8 (Join-Path $kit 'scripts\run.py') doctor
if ($LASTEXITCODE -ne 0) { throw 'PPT runtime is blocked. See the doctor report above.' }
Write-Host 'PPT runtime installed. Start/restart Electron to use local PPT tools.'
