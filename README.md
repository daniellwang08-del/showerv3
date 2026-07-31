# Job Scraper

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

## Install

### 1. Clone and enter the project

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

**Windows**

```cmd
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

**macOS / Linux**

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

### 4. Environment file

**Windows**

```cmd
copy env.example .env
```

**macOS / Linux**

```bash
cp env.example .env
```

Edit `.env` and set at minimum:

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

## Run

The app needs **one API server**, **six workers**, and **one frontend dev server**.

### Windows (all services)

From the project root, with `venv` already created and `.env` configured:

```cmd
start.cmd
```

This opens 8 windows: API, extraction, analysis, tailoring, save, resume, scraper workers, and the frontend.

Production-style env (uses `.env.production`):

```cmd
start-prod.cmd
```

### Manual start (Windows, macOS, Linux)

Run each command in its **own terminal**. Activate the virtualenv first.

```bash
# 0. Redis (+ Postgres if you use the docker-db profile)
docker compose up -d redis
# optional: docker compose --profile docker-db up -d postgres

# 1. API (http://localhost:8000)
python start_server.py

# 2. Extraction worker (URL scraping)
python run_worker.py extraction

# 3. Analysis worker (Phase A match scoring)
python run_worker.py analysis

# 4. Tailoring worker (Phase B resume tailoring — dedicated queue)
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

### URLs

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
