@echo off
echo ==========================================
echo   OpenChat - WeChat + OpenCode Bridge
echo ------------------------------------------
echo   Starting...
echo   First run: prepare WeChat QR scan
echo   Stop with Ctrl+C or close this window
echo ==========================================
echo.
node "%~dp0bridge.js" %*
:: Only pause if launched via double-click (not from terminal)
echo %CMDCMDLINE% | find /i "%~0" >nul 2>&1
if not errorlevel 1 pause
