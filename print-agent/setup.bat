@echo off
cd /d "%~dp0"
where py >nul 2>nul || (echo Python 3.10+ is required. Install it from python.org and tick "Add to PATH". & pause & exit /b 1)
if not exist .venv py -3 -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt || (echo Install failed. & pause & exit /b 1)
.venv\Scripts\python main.py setup
pause
