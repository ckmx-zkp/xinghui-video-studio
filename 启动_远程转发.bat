@echo off
chcp 65001 >nul
title 星绘远程转发
echo 阿里云只做转发。导演台仍在本机 4175。
echo 公网: http://47.108.114.17:8110
echo 账号密码见同目录 remote-forward.txt
:loop
ssh -F "%USERPROFILE%\.ssh\config" -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:17415:127.0.0.1:4175 aliyun_ecs
echo 转发断开，5 秒后重连...
timeout /t 5 /nobreak >nul
goto loop
