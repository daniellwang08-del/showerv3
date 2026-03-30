@echo off
title Job Scraper - Launcher
cd /d "%~dp0"

:: Default to local environment if not specified
if "%APP_ENV%"=="" set APP_ENV=local

echo ============================================
echo   Job Scraper - Starting all services...
echo   Environment: %APP_ENV%
echo ============================================
echo.

:: Backend API server
echo [1/3] Starting backend API server...
start "Backend API (port 8000)" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && venv\Scripts\python.exe start_server.py"

:: arq background worker
echo [2/3] Starting arq worker...
start "arq Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && venv\Scripts\python.exe run_worker.py"

:: Frontend dev server
echo [3/3] Starting frontend dev server...
start "Frontend (port 5173)" cmd /k "cd /d "%~dp0\frontend" && npm run dev"

echo.
echo ============================================
echo   All services launched!  [%APP_ENV%]
echo.
echo   Backend API:  http://localhost:8000
echo   Frontend:     http://localhost:5173
echo   API Docs:     http://localhost:8000/docs
echo ============================================
echo.
echo Close this window or press any key to exit.
echo (The service windows will keep running.)
pause >nul
