param([string]$Python = 'python', [string]$RuntimeDirectory = (Join-Path $env:LOCALAPPDATA 'kla-workstation\excel-runtime'))
$ErrorActionPreference = 'Stop'
$kit = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps\desktop\resources\skills\excel-pro'
& $Python -m venv $RuntimeDirectory
if ($LASTEXITCODE -ne 0) { throw 'Unable to create Python virtual environment (Python 3.8+ required).' }
$exe = Join-Path $RuntimeDirectory 'Scripts\python.exe'
& $exe -m pip install -r (Join-Path $kit 'scripts\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Excel analysis dependencies installation failed.' }
$probe = @'
import importlib, json, sys
mods = {"python": sys.version.split()[0]}
for name in ("pandas", "openpyxl", "matplotlib"):
    try:
        mods[name] = importlib.import_module(name).__version__
    except Exception:
        mods[name] = None
print(json.dumps(mods))
'@
& $exe -X utf8 -c $probe
if ($LASTEXITCODE -ne 0) { throw 'Excel runtime is blocked. See the probe output above.' }
Write-Host 'Excel runtime installed. Start/restart Electron to use local Excel tools.'
Write-Host 'Tip: KLA_EXCEL_PYTHON environment variable overrides the interpreter at any time.'
