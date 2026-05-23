@echo off
echo ╔══════════════════════════════════════════╗
echo ║  OpenChat - WeChat + OpenCode Bridge   ║
echo ╠══════════════════════════════════════════╣
echo ║  启动中...                              ║
echo ║  首次运行请准备微信扫码                  ║
echo ║  关闭此窗口 = 停止桥接                  ║
echo ╚══════════════════════════════════════════╝
echo.
node "%~dp0bridge.js"
pause
