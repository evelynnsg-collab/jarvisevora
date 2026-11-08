@echo off
setlocal
cd /d "%~dp0"
title EVORA - Ativar abrir com palmas

rem Acha o Python (mesma ordem do ABRIR_EVORA.bat), preferindo pythonw (sem janela)
set "PYW="
if exist ".venv\Scripts\pythonw.exe" set "PYW=%CD%\.venv\Scripts\pythonw.exe"
if not defined PYW if exist "venv\Scripts\pythonw.exe" set "PYW=%CD%\venv\Scripts\pythonw.exe"
if not defined PYW for /f "delims=" %%P in ('where pythonw 2^>nul') do if not defined PYW set "PYW=%%P"
if not defined PYW (
  echo ERRO: nao encontrei o Python. Rode antes o CONFIGURAR_EVORA.bat.
  pause
  exit /b 1
)

rem Confere as bibliotecas
"%PYW:pythonw.exe=python.exe%" -c "import sounddevice, numpy" 2>nul
if errorlevel 1 (
  echo Instalando sounddevice e numpy...
  "%PYW:pythonw.exe=python.exe%" -m pip install sounddevice numpy
)

rem Cria o atalho na pasta Inicializar do Windows (roda sozinho ao ligar o PC)
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\EvoraPalmas.vbs"
> "%VBS%" echo Set s = CreateObject("WScript.Shell")
>> "%VBS%" echo s.CurrentDirectory = "%CD%"
>> "%VBS%" echo s.Run """%PYW%"" ""%CD%\evora_palmas.py""", 0, False

rem Inicia agora, sem janela
start "" wscript "%VBS%"

echo.
echo  Pronto! A Evora agora abre com DUAS PALMAS.
echo  - Ja esta ouvindo e vai iniciar sozinha sempre que o PC ligar.
echo  - Na primeira vez, entre com sua senha na janela da Evora.
echo  - Para testar o microfone: python evora_palmas.py --teste
echo  - Para desligar: DESATIVAR_PALMAS.bat
echo.
pause
