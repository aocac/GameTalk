@echo off
rem GameTalk second client (browser) - double-click this file
chcp 65001 >nul
cd /d "%~dp0"
node client/scripts/second-client.mjs
pause
