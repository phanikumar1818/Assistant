@echo off
cd /d "%~dp0"
start "" node_modules\electron\dist\electron.exe . --no-sandbox --disable-gpu
exit
