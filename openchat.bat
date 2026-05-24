@echo off
echo ==========================================
echo   OpenChat - WeChat + OpenCode Bridge
echo ------------------------------------------
echo   Starting...
echo   First run: prepare WeChat QR scan
echo   Close this window to stop bridge
echo ==========================================
echo.
node "%~dp0bridge.js" %*
pause
