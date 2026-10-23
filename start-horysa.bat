@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  start "Horysa local server" cmd /k "py -m http.server 4173"
) else (
  start "Horysa local server" cmd /k "python -m http.server 4173"
)
timeout /t 2 /nobreak >nul
start "" "http://localhost:4173"
