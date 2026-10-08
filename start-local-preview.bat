@echo off
setlocal
title KLA Workstation - Local Preview
cd /d "%~dp0"

if not exist "%~dp0scripts\start-local-preview.ps1" (
  echo [ERROR] scripts\start-local-preview.ps1 is missing.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-preview.ps1" %*
set "KLA_PREVIEW_EXIT=%ERRORLEVEL%"
if not "%KLA_PREVIEW_EXIT%"=="0" (
  echo.
  echo Preview startup failed. Read the error above and the logs in .runtime\preview.
  pause
)
exit /b %KLA_PREVIEW_EXIT%
