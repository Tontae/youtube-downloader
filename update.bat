@echo off
cd /d "%~dp0"
echo Updating yt-dlp...
bin\yt-dlp.exe -U
echo.
pause
