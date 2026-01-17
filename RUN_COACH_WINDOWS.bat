@echo off
setlocal

REM Realtime Coach (Browser-only) launcher
REM Requires: Python 3 installed and added to PATH

cd /d %~dp0

echo Starting local web server at http://127.0.0.1:8000 ...
echo Open this URL in your browser:
echo   http://127.0.0.1:8000/src/gui/xiangqi.html
echo.

python -m http.server 8000

endlocal
