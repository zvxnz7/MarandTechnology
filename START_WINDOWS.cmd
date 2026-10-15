@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<24 || (a===24 && b<15)) process.exit(1)"
if errorlevel 1 goto old_node
set "MARAND_DATA=%~dp0data"
node manage.js init
if errorlevel 1 goto fail
echo.
echo Otworz w przegladarce http://127.0.0.1:8765
node manage.js run --host 127.0.0.1 --port 8765
pause
exit /b
:missing_node
echo Nie znaleziono Node.js. Zainstaluj Node.js 24.15 lub nowszy.
pause
exit /b 1
:old_node
echo Ta aplikacja wymaga Node.js 24.15 lub nowszego.
pause
exit /b 1
:fail
echo Nie udalo sie uruchomic. Zapisz komunikat powyzej.
pause
exit /b 1
