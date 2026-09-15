@echo off
chcp 65001 >nul
title WeChat Miniapp Token Extractor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js not found. Please install it first:
  echo       https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0get-token.js"

echo.
echo   ------------------------------------------------
echo   Press any key to close...
pause >nul
