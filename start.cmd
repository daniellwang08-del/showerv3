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
  :: Multiple workers all watching app/ with RELOAD=1 causes a restart storm on
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

:: Ensure local Redis + Postgres are reachable before launching workers.
echo [0/10] Ensuring Redis + Postgres...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure_local_deps.ps1"
if errorlevel 1 (
  echo.
  echo ERROR: Redis/Postgres dependency check failed.
  pause
  exit /b 1
)

:: Stop any previously launched API/worker processes so a fresh start always
:: serves the latest code. Closing the old service windows does NOT kill their
:: detached python children, which keep holding port 8000 (the new server then
:: silently loses the port race and the stale code keeps answering). We scope
:: the kill to this project's start_server.py / run_worker.py processes, their
:: uvicorn reload children, and whatever currently owns port 8000.
echo [1/10] Stopping any existing API/worker processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $p=Get-CimInstance Win32_Process; $s=$p | Where-Object { $_.CommandLine -match 'start_server\.py|run_worker\.py' }; $ids=$s | ForEach-Object { $_.ProcessId }; $f=$p | Where-Object { $_.CommandLine -match 'multiprocessing-fork' -and $ids -contains $_.ParentProcessId }; $s + $f | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
timeout /t 2 /nobreak >nul

:: Frontend needs local vite binary from node_modules
if not exist "%~dp0frontend\node_modules\vite" (
  echo [1b/10] Installing frontend dependencies ^(npm install^)...
  pushd "%~dp0frontend"
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed in frontend\
    popd
    pause
    exit /b 1
  )
  popd
)

:: Backend API server
echo [2/10] Starting backend API server...
start "Backend API (port 8000)" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "RELOAD=%RELOAD%" && venv\Scripts\python.exe start_server.py"

:: arq extraction worker (scraping individual URLs)
echo [3/10] Starting extraction worker...
start "Extraction Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py extraction"

:: arq analysis worker (Phase A match scoring)
echo [4/10] Starting analysis worker...
start "Analysis Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py analysis"

:: arq tailoring worker (Phase B resume tailoring)
echo [5/10] Starting tailoring worker...
start "Tailoring Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py tailoring"

:: arq save worker (post-analysis dedup + persistence + Phase B enqueue)
echo [6/10] Starting save worker...
start "Save Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py save"

:: arq autopost worker (Sheets/Pumble — off the save critical path)
echo [7/10] Starting autopost worker...
start "Autopost Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py autopost"

:: arq resume build worker (DOCX/PDF generation)
echo [8/10] Starting resume build worker...
start "Resume Build Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py resume"

:: arq scraper worker (Scrapy spiders via Sync button)
echo [9/10] Starting scraper worker...
start "Scraper Worker" cmd /k "cd /d "%~dp0" && set "APP_ENV=%APP_ENV%" && set "WORKER_RELOAD=%WORKER_RELOAD%" && venv\Scripts\python.exe run_worker.py scraper"

:: Frontend dev server (Vite HMR - hot reload built in)
echo [10/10] Starting frontend dev server...
for /f "delims=" %%i in ('venv\Scripts\python.exe scripts\lan_urls.py --ip 2^>nul') do set "LAN_HOST=%%i"
start "Frontend (port 5173)" cmd /k "cd /d "%~dp0\frontend" && set "LAN_HOST=%LAN_HOST%" && npm run dev"

echo.
echo ============================================
echo   All services launched!  [%APP_ENV%]
echo.
echo   Backend API:  http://localhost:8000
echo   Frontend:     http://localhost:5173
echo   API Docs:     http://localhost:8000/docs
echo   Postgres:     localhost:5432
echo   Redis:        localhost:6379  ^(Docker^)
venv\Scripts\python.exe scripts\lan_urls.py
echo.
echo   Other devices on your Wi-Fi/LAN can open the Frontend LAN URL above.
echo   Use port 5173 only - do not share http://^<ip^>:8000 with other users.
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
