@echo off
chcp 936 >nul
setlocal
title qq-bridge - starting

rem ============================================================
rem  qq-bridge launcher
rem  Keep this window open while the bridge is running.
rem ============================================================

cd /d "%~dp0"

echo.
echo  +--------------------------------------------------------+
echo  |                     qq-bridge                          |
echo  +--------------------------------------------------------+
echo.

rem ---- preflight checks -------------------------------------
if not exist "config.json" (
    echo  [x] config.json not found
    echo      Run install.bat first.
    pause
    exit /b 1
)

echo  Checking environment...
echo.

rem SnowLuma (port 3000)
powershell -NoProfile -Command ^
  "if ((Test-NetConnection 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue).TcpTestSucceeded) { Write-Host '    OK   SnowLuma is up' } else { Write-Host '    XX   SnowLuma is not running'; Write-Host '         Run launcher.bat and scan the QR code first'; exit 1 }"
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)

rem DeepSeek Harness (resolved at runtime; this is only a hint)
powershell -NoProfile -Command ^
  "if ((Test-NetConnection 127.0.0.1 -Port 43129 -WarningAction SilentlyContinue).TcpTestSucceeded) { Write-Host '    OK   DeepSeek Harness is up' } else { Write-Host '    !!   DeepSeek Harness port not found'; Write-Host '         Starting the bridge anyway; it will resolve the port itself' }"

echo.
echo  ----------------------------------------------------------
echo   The AI will answer in QQ.
echo.
echo   - Do NOT close this window.
echo   - Talk to her from your QQ client.
echo.
echo   To stop: close this window or press Ctrl+C.
echo  ----------------------------------------------------------
echo.

chcp 65001 >nul
rem DSH desktop uses a random port; resolve it before starting the bridge.
rem Harden state/ ACL before starting: drop inherited permissions so other
rem local users cannot read chat logs, tokens, or session state.
rem The helper exits 0 even on failure (non-blocking) by design.
node scripts\harden-state-acl.mjs

node scripts\resolve-dsh-port.mjs --quiet
node src/bridge.js
chcp 936 >nul

echo.
echo  Bridge stopped.
echo.
pause
endlocal
