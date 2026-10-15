@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0control-server.ps1" -Action start -ConfigPath "%~dp0konfiguracja.json"
pause
