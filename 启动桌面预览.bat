@echo off
setlocal

rem Always launch the preview from this script's repository root.
cd /d "%~dp0"
title KLA Workstation - Desktop Preview

if not exist "package.json" (
  echo [KLA] package.json was not found in:
  echo       %CD%
  echo [KLA] Put this .bat file in the repository root and try again.
  pause
  exit /b 1
)

where pnpm >nul 2>&1
if not errorlevel 1 (
  set "PNPM_CMD=pnpm"
) else (
  where corepack >nul 2>&1
  if errorlevel 1 (
    echo [KLA] pnpm or corepack was not found. Install Node.js 22+ and pnpm 11+ first.
    pause
    exit /b 1
  )
  set "PNPM_CMD=corepack pnpm"
)

echo [KLA] Starting the latest desktop preview...
echo [KLA] Repository: %CD%
echo [KLA] Close this window to stop the preview.
echo.

%PNPM_CMD% dev
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" echo [KLA] Preview exited with code %EXIT_CODE%.
if "%EXIT_CODE%"=="0" echo [KLA] Preview stopped.
pause
exit /b %EXIT_CODE%
