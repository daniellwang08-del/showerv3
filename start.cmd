@echo off
title Job Scraper - Launcher
cd /d "%~dp0"

:: Default to local development if not specified
if "%APP_ENV%"=="" set APP_ENV=local

:: Auto-reload Python services when app/ code changes (local dev only)
if /i "%APP_ENV%"=="production" (
  set RELOAD=0
) else (
  set RELOAD=1
)

echo ============================================
echo   Job Scraper - Starting all services...
echo   Environment: %APP_ENV%
if "%RELOAD%"=="1" (
  echo   Auto-reload: ON  ^(API + workers watch app/^)
) else (
  echo   Auto-reload: OFF ^(production^)
)
echo ============================================
echo.

:: Backend API server
echo [1/7] Starting backend API server...
start "Backend API (port 8000)" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && set RELOAD=%RELOAD% && venv\Scripts\python.exe start_server.py"

:: arq extraction worker (scraping individual URLs)
echo [2/7] Starting extraction worker...
start "Extraction Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && set RELOAD=%RELOAD% && venv\Scripts\python.exe run_worker.py extraction"

:: arq analysis worker (OpenAI match scoring)
echo [3/7] Starting analysis worker...
start "Analysis Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && set RELOAD=%RELOAD% && venv\Scripts\python.exe run_worker.py analysis"

:: arq save worker (post-analysis dedup + persistence)
echo [4/7] Starting save worker...
start "Save Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && set RELOAD=%RELOAD% && venv\Scripts\python.exe run_worker.py save"

:: arq resume build worker (DOCX/PDF generation)
echo [5/7] Starting resume build worker...
start "Resume Build Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && set RELOAD=%RELOAD% && venv\Scripts\python.exe run_worker.py resume"

:: arq scraper worker (Scrapy spiders via Sync button)
echo [6/7] Starting scraper worker...
start "Scraper Worker" cmd /k "cd /d "%~dp0" && set APP_ENV=%APP_ENV% && set RELOAD=%RELOAD% && venv\Scripts\python.exe run_worker.py scraper"

:: Frontend dev server (Vite HMR — hot reload built in)
echo [7/7] Starting frontend dev server...
start "Frontend (port 5173)" cmd /k "cd /d "%~dp0\frontend" && npm run dev"

echo.
echo ============================================
echo   All 7 services launched!  [%APP_ENV%]
echo.
echo   Backend API:  http://localhost:8000
echo   Frontend:     http://localhost:5173
echo   API Docs:     http://localhost:8000/docs
if "%RELOAD%"=="1" (
  echo.
  echo   Tip: edit files under app/ and save — API and workers restart automatically.
)
echo ============================================
echo.
echo Close this window or press any key to exit.
echo (The service windows will keep running.)
pause >nul
