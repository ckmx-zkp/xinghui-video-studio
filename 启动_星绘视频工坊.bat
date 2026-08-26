@echo off
chcp 65001 >nul
set "ROOT=%~dp0"
set "STUDIO_DIR=%ROOT%video-studio"

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 4175 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  start "" "http://127.0.0.1:4175"
  powershell -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '17415:127.0.0.1:4175' }) { exit 0 } else { exit 1 }"
  if errorlevel 1 start "星绘远程转发" /min cmd /c call "%ROOT%启动_远程转发.bat"
  echo 星绘视频工坊已在运行：http://127.0.0.1:4175
  timeout /t 3 >nul
  exit /b 0
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 start "ComfyUI H3" /min cmd /c call "%ROOT%启动_H3_低显存.bat"

cd /d "%STUDIO_DIR%"
start "星绘远程转发" /min cmd /c call "%ROOT%启动_远程转发.bat"
start "" "http://127.0.0.1:4175"
node server.mjs
pause
