@echo off
rem GameTalk second client (browser) - double-click this file
chcp 65001 >nul
cd /d "%~dp0.."
node dev/second-client.mjs
pause
