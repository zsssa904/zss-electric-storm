@echo off
setlocal
cd /d "%~dp0"

set "PORT=5173"

where node >nul 2>nul
if errorlevel 1 (
  if exist "E:\software\node.exe" (
    set "NODE=E:\software\node.exe"
  ) else (
    echo Node.js not found. Install Node.js 18+ first.
    pause
    exit /b 1
  )
) else (
  set "NODE=node"
)

echo Starting Electric Storm on http://127.0.0.1:%PORT% ...
start "Electric Storm Server" %NODE% serve.mjs %PORT%
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/"

echo.
echo The server is running in the "Electric Storm Server" window.
echo Keep that window open. Close it (or press Ctrl+C there) to stop.
timeout /t 4 /nobreak >nul
endlocal
