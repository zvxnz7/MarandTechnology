@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0wykonaj.ps1" -Operation backup
pause
