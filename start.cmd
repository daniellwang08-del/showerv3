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
echo [1/5] Starting backend API server...
start "Backend API (port 8000)" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && venv\Scripts\python.exe start_server.py"

:: arq extraction worker (scraping)
echo [2/5] Starting extraction worker...
start "Extraction Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && venv\Scripts\python.exe run_worker.py extraction"

:: arq analysis worker (OpenAI match scoring)
echo [3/5] Starting analysis worker...
start "Analysis Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && venv\Scripts\python.exe run_worker.py analysis"

:: arq resume build worker (DOCX/PDF generation)
echo [4/5] Starting resume build worker...
start "Resume Build Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && venv\Scripts\python.exe run_worker.py resume"

:: Frontend dev server
echo [5/5] Starting frontend dev server...
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
