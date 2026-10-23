@echo off
setlocal EnableExtensions
rem Release root launcher: keep this file next to the Stronghold-Protocol-Vanilla-20p folder.
call "%~dp0Stronghold-Protocol-Vanilla-20p\scripts\start-windows.bat" %*
exit /b %errorlevel%