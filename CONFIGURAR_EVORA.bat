@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  python configurar_evora.py
) else (
  py -3 configurar_evora.py
)
pause
