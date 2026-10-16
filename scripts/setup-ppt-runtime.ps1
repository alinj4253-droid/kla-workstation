param(
  [string]$Node = 'node',
  [string]$Python = '',
  [string]$RuntimeDirectory = (Join-Path $env:LOCALAPPDATA 'kla-workstation\ppt-runtime')
)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$engine = Join-Path $project 'apps\desktop\resources\skills\deck-agent-kit\vendor\slidep\index.cjs'
if (-not (Test-Path -LiteralPath $engine)) { throw 'Bundled slidep engine is missing.' }
& $Node (Join-Path $project 'scripts\verify-ppt-runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Real PPT generation smoke test failed. Check Node, installed packages, and bundled slidep resources.' }
Write-Host 'pptx-deck-builder generation passed a real editable PPTX smoke test. Python is optional.'

if ($Python) {
  $kit = Join-Path $project 'apps\desktop\resources\skills\deck-agent-kit'
  & $Python -m venv $RuntimeDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create optional Python environment (Python 3.10+ required).' }
  $exe = Join-Path $RuntimeDirectory 'Scripts\python.exe'
  & $exe -m pip install -r (Join-Path $kit 'scripts\requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Optional PPT inspect/render dependencies installation failed.' }
  Write-Host 'Optional PPT inspect/render dependencies installed. An Office/WPS or LibreOffice converter is still needed for PDF preview.'
}
