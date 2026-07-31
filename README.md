# Atomspace / Job Scraper — Setup Guide

## Prerequisites

Install these before setup:

| Tool | Version | Notes |
|------|---------|--------|
| Python | 3.12+ | Backend, workers, Scrapy |
| Node.js | 18+ | Frontend (`frontend/`) |
| PostgreSQL | 14+ | Main database (Docker Compose recommended) |
| Docker | recent | Local Redis + Postgres via `docker compose` (recommended) |

Optional but recommended:

- **Playwright browsers** - SPA extraction and Scrapy Playwright spiders  
  `playwright install chromium`
- **Redis Insight** - queue/key UI at http://localhost:5540  
  `docker compose --profile tools up -d`

PDF export uses the pure-Python **`dxpdf`** package (`pip install` via `requirements.txt`). No LibreOffice / MS Office install is required.

---

## What you need

| Tool | Version | Notes |
|------|---------|--------|
| **Python** | 3.12+ (3.13 OK) | Backend, workers, Scrapy |
| **Node.js** | 18+ | Frontend |
| **PostgreSQL** | 14+ | Database |
| **Redis** | 6+ | Job queues — on Windows use [Memurai](https://www.memurai.com/) or Redis in WSL/Docker |

Optional later (not required for first boot):

- OpenAI-compatible API key (analysis, tailoring, assistant)
- Playwright Chromium (browser extraction / some spiders)
- Google Sheets credentials / Pumble (integrations)
- Scraper platform login sessions (RemoteRocketship, Jobright)

---

## 1. Clone the repo

```bash
git clone <your-repo-url>
cd job_scraper
```

### 2. Redis + Postgres

```bash
docker compose up -d redis
```

Redis 7 listens on `6379` (AOF + `maxmemory-policy noeviction` for arq).

**Postgres** — use a local install by default (Windows service / Homebrew / apt) on `5432`. Your `DATABASE_URL` must match that instance.

If you have no local Postgres, use the optional Docker profile (do **not** run this while another Postgres already owns `:5432`):

```bash
docker compose --profile docker-db up -d postgres
```

`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` in `.env` must match `DATABASE_URL`.

Optional Redis UI:

```bash
docker compose --profile tools up -d
# open http://localhost:5540 — add Redis at host.docker.internal:6379 (Windows/Mac)
```

`start.cmd` starts Redis, ensures Windows PostgreSQL is running when present, and only falls back to Docker Postgres if `:5432` is still closed.

### 3. Backend (Python)

---

## 2. Python virtualenv + packages

### Windows (Command Prompt)

```cmd
python -m venv venv
venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
playwright install chromium
```

If `python` opens the Microsoft Store or says “Python was not found”, use the full path instead:

```cmd
C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python313\python.exe -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe -m playwright install chromium
```

### macOS / Linux

```bash
python3 -m venv venv
source venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
playwright install chromium
```

### 4. Environment file

```bash
python -c "import sys; print(sys.executable)"
```

You should see a path under `...\job_scraper\venv\...`.

---

## 3. PostgreSQL database

Create an empty database (name must match `.env`):

```sql
CREATE DATABASE job_scraper;
```

Default connection used in `env.example`:

`postgresql+asyncpg://postgres:postgres@localhost:5432/job_scraper`

Change user/password/host in `.env` if yours differ.

---

## 4. Redis

Start Redis (or Memurai on Windows) and confirm it listens on `localhost:6379`.

Default URL:

`redis://localhost:6379/0`

---

## 5. Environment file

### Windows

```cmd
copy env.example .env
```

### macOS / Linux

```bash
cp env.example .env
```

Edit `.env` and set at least:

| Variable | Example |
|----------|---------|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Compose Postgres (`postgres` / `postgres` / `job_scraper`) |
| `DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5432/job_scraper` (must match `POSTGRES_*`) |
| `REDIS_URL` | `redis://localhost:6379/0` (arq broker) |
| `REDIS_CACHE_URL` | `redis://localhost:6379/1` (extraction cache; local Docker) |
| `REDIS_PUBSUB_URL` | `redis://localhost:6379/2` (WebSocket events; local Docker) |
| `OPENAI_API_KEY` | Your OpenAI key |
| `AUTH_SECRET_KEY` | Long random string for JWT signing |

On managed Redis that only exposes DB `0` (e.g. Render Key Value), leave `REDIS_CACHE_URL` / `REDIS_PUBSUB_URL` unset so they reuse `REDIS_URL`.

Create the PostgreSQL database if it does not exist, then run migrations:

```bash
alembic upgrade head
```

### 5. Frontend

```bash
cd frontend
npm install
cd ..
```

---

## 8. Start everything

The app needs **one API server**, **six workers**, and **one frontend dev server**.

From the **project root**, with `venv` already created and `.env` filled:

```cmd
start.cmd
```

This opens **8** windows:

1. API server (`:8000`)
2. Extraction worker  
3. Analysis worker  
4. Tailoring worker  
5. Save worker  
6. Resume build worker  
7. Scraper worker  
8. Frontend (`:5173`)

Production overlay (loads `.env.production`):

```cmd
start-prod.cmd
```

### Manual start (any OS)

Use **one terminal per process**. Activate the venv in each Python terminal first.

```bash
# 0. Redis (+ Postgres if you use the docker-db profile)
docker compose up -d redis
# optional: docker compose --profile docker-db up -d postgres

# 1. API (http://localhost:8000)
python start_server.py

# Terminal 2 — Extraction
python run_worker.py extraction

# Terminal 3 — Analysis
python run_worker.py analysis

# Terminal 4 — Tailoring
python run_worker.py tailoring

# 5. Save worker (post-analysis persistence + Phase B enqueue)
python run_worker.py save

# 6. Autopost worker (Sheets/Pumble — off the save critical path)
python run_worker.py autopost

# 7. Resume build worker (DOCX/PDF generation)
python run_worker.py resume

# 8. Scraper worker (platform sync / Scrapy)
python run_worker.py scraper

# 9. Frontend (http://localhost:5173)
cd frontend && npm run dev
```

On Windows without activation, prefix Python commands with `.\venv\Scripts\python.exe`.

---

## 9. Open the app

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| API | http://localhost:8000 |
| API docs | http://localhost:8000/docs |
| Redis Insight (optional) | http://localhost:5540 |

Ensure PostgreSQL and Redis are running before starting the backend.

### Production notes

- `APP_ENV=production` (or `REDIS_REQUIRE_FOR_JOBS=true`) disables in-process FastAPI `BackgroundTasks` fallback — enqueue failures return HTTP 503.
- Render blueprint (`render.yaml`) runs all six workers + Redis Key Value with `noeviction`.
- Health: `GET /api/v1/health` reports `degraded` when Redis broker/cache/pubsub cannot be pinged.
