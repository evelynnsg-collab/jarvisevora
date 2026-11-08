@echo off
title EVORA - Desativar abrir com palmas
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EvoraPalmas.vbs" 2>nul
rem encerra o ouvinte que estiver rodando
wmic process where "commandline like '%%evora_palmas.py%%' and name like 'python%%'" call terminate >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*evora_palmas.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
echo Abrir com palmas desativado.
pause
