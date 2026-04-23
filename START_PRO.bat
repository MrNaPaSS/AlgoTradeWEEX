@echo off
title AlgoTrade Pro v2.0 - Starter (PERMANENT NGROK)
setlocal

:: Get the directory of the script
set "BASE_DIR=%~dp0"
cd /d "%BASE_DIR%"

echo.
echo  ##########################################
echo  #         AlgoTrade Pro v2.0             #
echo  #      Enterprise AI Trading System      #
echo  ##########################################
echo.

echo [1/3] Cleaning up old processes...
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM ssh.exe /T >nul 2>&1
taskkill /F /IM ngrok.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] Starting AlgoTrade Bot...
start "AlgoTrade BOT" cmd /k "node src/app.js"

echo [3/3] Starting Permanent Ngrok Tunnel...
echo Domain: valid-murmuring-enticing.ngrok-free.dev
echo.
echo  !!! ГОТОВО !!!
echo  В TradingView должна быть ВСЕГДА эта ссылка:
echo  https://valid-murmuring-enticing.ngrok-free.dev/webhook
echo.
timeout /t 3 /nobreak >nul

:: Start ngrok with the permanent domain
start "Ngrok Tunnel" cmd /k "ngrok http --url=valid-murmuring-enticing.ngrok-free.dev 3000"

echo.
echo ==========================================
echo    СИСТЕМА ЗАПУЩЕНА (ВЕЧНАЯ ССЫЛКА)
echo ==========================================
echo  1. Дождись в Телеграме сообщения с зеленой точкой.
echo  2. Проверь TradingView (ссылка зафиксирована).
echo ==========================================
echo.
pause
