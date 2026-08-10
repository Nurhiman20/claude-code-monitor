@echo off
rem Keeps the monitor server alive; restarts it a few seconds after any crash.
cd /d "%~dp0..\server"
set NODE_EXE=node
where node >nul 2>&1 || set NODE_EXE="C:\Program Files\nodejs\node.exe"

:loop
echo [%date% %time%] starting claude-monitor >> server.log
%NODE_EXE% index.js >> server.log 2>&1
echo [%date% %time%] exited with code %errorlevel%, restarting in 5s >> server.log
timeout /t 5 /nobreak >nul
goto loop
