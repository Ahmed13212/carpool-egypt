@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Carpool Egypt web interface...
echo Open http://localhost:3000 in your browser.
node apps\web\server.cjs
pause
