@echo off
setlocal
cd /d "%~dp0"
title EVORA - Iniciar versao com imagem
if not exist "face.png" (
  echo ERRO: face.png nao encontrado. Extraia o ZIP inteiro antes de abrir.
  pause
  exit /b 1
)
if exist ".venv\Scripts\python.exe" (
  set "EVORA_PYTHON=.venv\Scripts\python.exe"
  goto iniciar
)
if exist "venv\Scripts\python.exe" (
  set "EVORA_PYTHON=venv\Scripts\python.exe"
  goto iniciar
)
where py >nul 2>nul
if errorlevel 1 (
  set "EVORA_PYTHON=python"
) else (
  set "EVORA_PYTHON=py"
)
:iniciar
echo Abrindo a Evora desta pasta:
echo %CD%
"%EVORA_PYTHON%" configurar_evora.py
if errorlevel 1 goto erro
"%EVORA_PYTHON%" main.py
if errorlevel 1 goto erro
exit /b 0
:erro
echo.
echo A Evora nao iniciou corretamente. Envie um print desta janela.
pause
exit /b 1
