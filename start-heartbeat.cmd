@echo off
rem ===========================================================================
rem  start-heartbeat.cmd - double-click entry point for the status heartbeat
rem  Runs scripts\start.ps1 (install check + start watcher + status report).
rem ===========================================================================
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
echo.
pause
