@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if defined NODE_EXE (
  "%NODE_EXE%" -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<24 || (a===24 && b<15)) process.exit(1)"
  if not errorlevel 1 goto run_panel
)
set "CODEX_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%CODEX_NODE%" goto missing_node
set "NODE_EXE=%CODEX_NODE%"
"%NODE_EXE%" -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<24 || (a===24 && b<15)) process.exit(1)"
if errorlevel 1 goto old_node
:run_panel
"%NODE_EXE%" server.js
pause
exit /b
:missing_node
echo Nie znaleziono Node.js 24.15 lub nowszego.
echo Zainstaluj Node.js 24.15 lub nowszy i uruchom panel ponownie.
pause
exit /b 1
:old_node
echo Panel wymaga Node.js 24.15 lub nowszego.
pause
exit /b 1
