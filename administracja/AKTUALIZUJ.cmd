@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Wszyscy uzytkownicy powinni zapisac zmiany i zakonczyc prace.
powershell.exe -NoProfile -File "%~dp0wykonaj.ps1" -Operation update
pause
