@echo off
rem GameTalk local server launcher (double-click this file)
chcp 65001 >nul
cd /d "%~dp0.."
node dev/start-local.mjs
pause
