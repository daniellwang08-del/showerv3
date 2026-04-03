# Job Scraper

Full-stack job extraction and analysis platform. Submit job posting URLs, automatically extract structured data via multi-strategy scraping, run AI-powered job-profile matching, and manage your application pipeline.

## Architecture

```
                                                  ┌──► Extraction Worker (arq)
Frontend (React/Vite) ──WebSocket──► API (FastAPI) ──Redis──┤     queue: job_extraction
         │                                │        └──► Analysis Worker   (arq)
         └──── REST API ───────────────────┘                  queue: job_analysis
                                           │                        │
                                      PostgreSQL  ◄─────────────────┘
```

**API Server** — FastAPI app handling REST endpoints, authentication (JWT), and WebSocket connections for real-time progress updates.

**Extraction Worker** — arq worker listening on the `job_extraction` queue. Runs I/O-heavy scraping tasks (HTTP fetches, Playwright browser rendering). Initializes HTTP client and browser pool on startup.

**Analysis Worker** — arq worker listening on the `job_analysis` queue. Runs API-heavy AI match analysis tasks (OpenAI). Only needs a database connection — no browser or HTTP client.

**Frontend** — React SPA with real-time WebSocket updates (no polling), job list management, profile editor, and AI match score display.

### Extraction Pipeline

Multi-strategy extraction with automatic fallback:

1. **Ashby API** — Direct public API call (no HTML needed)
2. **Greenhouse Board API** — Detects and uses Greenhouse endpoints
3. **JSON-LD** — Parses `schema.org/JobPosting` structured data
4. **Static HTML** — Readability + CSS selector extraction
5. **Browser Rendering** — Playwright for SPAs and dynamic content

Extracted data feeds directly into `JobDescriptionSchema` — no intermediate AI parsing step. On successful extraction, the worker automatically enqueues a match analysis job onto the separate analysis queue.

### Post-Extraction

- **Content-based deduplication** — Same-company and cross-company duplicate detection via title/description similarity and content hashing (SQL pre-filtered)
- **Company priority policy** — If you've applied to any job at the same company, new postings from that company are automatically demoted
- **AI match analysis** — OpenAI scores job-profile fit (0-100) with dimension breakdowns

## Prerequisites

- Python 3.12+
- Node.js 18+
- PostgreSQL
- Redis (or Memurai on Windows)

## Setup

```bash
# Backend
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux
pip install -r requirements.txt

# Copy env and configure required values
copy env.example .env        # Windows
# cp env.example .env        # macOS/Linux
```

Edit `.env` and set these required values:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (`postgresql+asyncpg://...`) |
| `REDIS_URL` | Redis connection (`redis://localhost:6379/0`) |
| `OPENAI_API_KEY` | OpenAI API key (required for match analysis and AI search) |
| `AUTH_SECRET_KEY` | JWT signing secret (generate a strong random string) |
| `AUTH_PASSWORD` | Application auth password |

```bash
# Run database migrations
alembic upgrade head

# Optional: Install Playwright browsers for SPA extraction
# playwright install

# Frontend
cd frontend
npm install
```

## Run

All four processes must run for full functionality:

```bash
# 1. API server (port 8000)
python start_server.py

# 2. Extraction worker (scrapes job pages — HTTP/browser)
python run_worker.py extraction

# 3. Analysis worker (AI match scoring — OpenAI)
python run_worker.py analysis

# 4. Frontend dev server (port 5173)
cd frontend && npm run dev
```

The two workers use independent Redis queues (`job_extraction` and `job_analysis`) so they process jobs concurrently without blocking each other. You can run multiple instances of either worker for horizontal scaling.

Jobs stay in "pending" status until a worker picks them up. The frontend receives real-time updates via WebSocket — no manual refresh needed.

## Environment Overlays

The app supports environment-specific config files:

- `.env` — base defaults (always loaded)
- `.env.local` — local development overrides
- `.env.production` — production overrides

Set `APP_ENV` to control which overlay loads (`local`, `production`). On hosted platforms like Render, env vars are injected directly.

## Test

```bash
pytest
```

## Deployment

A `render.yaml` Blueprint is included for Render.com deployment (API server, extraction worker, analysis worker, static frontend, Redis key-value store). Database is external (e.g. Neon PostgreSQL).
