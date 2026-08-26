@echo off
cd /d "%~dp0ComfyUI_windows_portable"
python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --enable-dynamic-vram --reserve-vram 1 --use-pytorch-cross-attention --disable-pinned-memory --fast-disk
pause
