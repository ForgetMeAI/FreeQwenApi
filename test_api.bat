@echo off
chcp 65001 >nul
title FreeQwenApi - API Test

echo.
echo ╔══════════════════════════════════════╗
echo ║  FreeQwenApi - API Test                ║
echo ╚══════════════════════════════════════╝
echo.

echo Запуск Node.js тестов...
echo.

cd /d "%~dp0"

echo Test 1: Обычный запрос (non-streaming)
node scripts/run_tests.js
echo.

echo Test 2: Streaming тест
node scripts/test_streaming.js
echo.

echo Test 3: Интерактивный чат (введите exit для выхода)
node scripts/interactive_chat.js
echo.

echo ╔══════════════════════════════════════╗
echo ║  All tests complete!                   ║
echo ╚══════════════════════════════════════╝
pause