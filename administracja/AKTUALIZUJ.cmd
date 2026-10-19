@echo off
setlocal
chcp 65001 >nul
echo Wszyscy uzytkownicy powinni zapisać zmiany i zakończyć pracę.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0wykonaj.ps1" -Operation update-latest
set "UPDATE_EXIT=%ERRORLEVEL%"
endlocal & exit /b %UPDATE_EXIT%
