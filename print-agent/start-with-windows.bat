@echo off
rem Starts the agent automatically every time this Windows user signs in.
cd /d "%~dp0"
schtasks /Create /TN "FLO Print Agent" /TR "\"%~dp0start.bat\"" /SC ONLOGON /RL LIMITED /F
if errorlevel 1 (echo Could not create the startup task. Try right-click - Run as administrator.) else echo Done. The agent will start when you sign in to Windows.
pause
