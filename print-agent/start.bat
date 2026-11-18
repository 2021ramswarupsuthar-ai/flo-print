@echo off
cd /d "%~dp0"
:loop
.venv\Scripts\python main.py run
echo Agent stopped. Restarting in 10 seconds (close this window to quit)...
timeout /t 10 >nul
goto loop
