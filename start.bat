@echo off
title Py2EXE Online - Windows build server
cd /d "%~dp0"
py -m pip install -r requirements.txt
py -m uvicorn app:app --host 0.0.0.0 --port 8000
pause
