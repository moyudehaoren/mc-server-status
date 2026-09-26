@echo off
rem ===========================================================================
rem  check-status.cmd - double-click entry point to check the status heartbeat
rem  Works no matter which directory you are in (cd's to its own folder first).
rem ===========================================================================
chcp 65001 >nul
cd /d "%~dp0"
echo === 线上数据（页面实际读到的内容）===
node tools\live-check.js
echo.
echo === 本地监听状态 ===
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\register-task.ps1" -Status
echo.
pause
