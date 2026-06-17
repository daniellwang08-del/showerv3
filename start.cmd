@echo off
title Job Scraper - Launcher
cd /d "%~dp0"

:: Default to local development if not specified
if "%APP_ENV%"=="" set APP_ENV=local

:: Auto-reload Python services when app/ code changes (local dev only)
if /i "%APP_ENV%"=="production" (
  set RELOAD=0
  set WORKER_RELOAD=0
) else (
  set RELOAD=1
  :: API hot-reloads on app/ saves; workers stay up unless WORKER_RELOAD=1.
  :: Five workers all watching app/ with RELOAD=1 causes a restart storm on
  :: bulk saves (IDE/agent touching many .py files at once).
  set WORKER_RELOAD=0
)

echo ============================================
echo   Job Scraper - Starting all services...
echo   Environment: %APP_ENV%
if "%RELOAD%"=="1" (
  if "%WORKER_RELOAD%"=="1" (
    echo   Auto-reload: API + all workers watch app/
  ) else (
    echo   Auto-reload: API only ^(workers stable; set WORKER_RELOAD=1 to enable^)
  )
) else (
  echo   Auto-reload: OFF ^(production^)
)
echo ============================================
echo.

:: NOTE: every `set` below uses the QUOTED form `set "VAR=value"`. The bare
:: form `set VAR=value && next_cmd` silently captures the space before `&&`
:: into the value (a classic Windows CMD trap). That's how LAN_HOST ended up
:: as "172.20.1.140 " and produced the broken HMR URL
:: `ws://172.20.1.140%20:5173/?token=...`, and how APP_ENV ended up as
:: "local " in worker tracebacks. Do not "simplify" these quotes away.

:: Backend API server
echo [1/7] Starting backend API server...
start "Backend API (port 8000)" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "RELOAD=%RELOAD%" && venv\Scripts\python.exe start_server.py"

:: arq extraction worker (scraping individual URLs)
echo [2/7] Starting extraction worker...
start "Extraction Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py extraction"

:: arq analysis worker (OpenAI match scoring)
echo [3/7] Starting analysis worker...
start "Analysis Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py analysis"

:: arq save worker (post-analysis dedup + persistence)
echo [4/7] Starting save worker...
start "Save Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py save"

:: arq resume build worker (DOCX/PDF generation)
echo [5/7] Starting resume build worker...
start "Resume Build Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py resume"

:: arq scraper worker (Scrapy spiders via Sync button)
echo [6/7] Starting scraper worker...
start "Scraper Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py scraper"

:: Frontend dev server (Vite HMR — hot reload built in)
echo [7/7] Starting frontend dev server...
for /f "delims=" %%i in ('venv\Scripts\python.exe scripts\lan_urls.py --ip 2^>nul') do set "LAN_HOST=%%i"
start "Frontend (port 5173)" cmd /k "cd /d "%~dp0\frontend" && set "LAN_HOST=%LAN_HOST%" && npm run dev"

echo.
echo ============================================
echo   All 7 services launched!  [%APP_ENV%]
echo.
echo   Backend API:  http://localhost:8000
echo   Frontend:     http://localhost:5173
echo   API Docs:     http://localhost:8000/docs
venv\Scripts\python.exe scripts\lan_urls.py
echo.
echo   Other devices on your Wi-Fi/LAN can open the Frontend LAN URL above.
echo   Use port 5173 only — do not share http://^<ip^>:8000 with other users.
echo   If the page does not load, allow port 5173 in Windows Firewall.
if "%RELOAD%"=="1" (
  echo.
  echo   Tip: saving app/ restarts the API. Workers stay running unless WORKER_RELOAD=1.
  echo   After worker-only code changes, restart that worker window or set WORKER_RELOAD=1.
)
echo ============================================
echo.
echo Close this window or press any key to exit.
echo (The service windows will keep running.)
pause >nul
