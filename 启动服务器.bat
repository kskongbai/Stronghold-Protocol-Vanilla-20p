@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 卫戍协议：盟约 - Stronghold Protocol
call "%~dp0scripts\start-windows.bat" %*
exit /b %errorlevel%
