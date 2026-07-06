@echo off
rem openchat-repl.cmd -- OpenChat v2 CLI, skip WeChat and enter REPL
node "%~dp0第二阶段-openchat-cli\bin\openchat.js" --no-wechat %*
