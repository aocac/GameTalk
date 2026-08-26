@echo off
rem ============================================
rem  GameTalk 本地服务器一键启动（Windows）
rem  双击本文件即可；数据持久化在 server\data\ 下
rem  启动后客户端连 http://127.0.0.1:8787
rem ============================================
setlocal
cd /d "%~dp0server"

if not exist node_modules (
  echo [GameTalk] 首次运行：正在安装服务端依赖（约 1 分钟）...
  call npm install
  if errorlevel 1 goto :error
)

if not exist dist (
  echo [GameTalk] 首次运行：正在构建服务端...
  call npm run build
  if errorlevel 1 goto :error
)

echo.
echo [GameTalk] 本地服务器已启动:  http://127.0.0.1:8787
echo [GameTalk] 客户端「设置 - 服务器地址」保持默认即可。
echo [GameTalk] 关闭本窗口即停止服务器。按 Ctrl+C 可优雅退出。
echo.
call node dist/index.js
goto :eof

:error
echo.
echo [GameTalk] 启动失败，请检查上方错误信息，或手动执行：
echo   cd server ^&^& npm install ^&^& npm run build ^&^& node dist/index.js
pause
