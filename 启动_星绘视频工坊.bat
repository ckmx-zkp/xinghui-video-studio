@echo off
chcp 65001 >nul
set "ROOT=%~dp0"

rem 云优先：工坊唯一入口在云端 8110，本机只负责 GPU 工人（ComfyUI）与隧道。

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 start "ComfyUI H3" /min cmd /c call "%ROOT%启动_H3_低显存.bat"

powershell -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '17415:127.0.0.1:4175' }) { exit 0 } else { exit 1 }"
if errorlevel 1 start "星绘远程转发" /min cmd /c call "%ROOT%启动_远程转发.bat"

start "" "http://47.108.114.17:8110"
echo 已打开云端工坊 http://47.108.114.17:8110
echo 本机 4175 仅开发调试：cd video-studio 后执行 node server.mjs
timeout /t 3 >nul
