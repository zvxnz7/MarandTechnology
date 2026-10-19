@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL_SERVER.ps1"
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" (
  echo Instalator zakończył się błędem %INSTALL_EXIT%. Przeczytaj komunikat powyżej.
  pause
)
endlocal & exit /b %INSTALL_EXIT%
