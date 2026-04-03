# Job Scraper

Full-stack job extraction and analysis platform. Submit job posting URLs, automatically extract structured data via multi-strategy scraping, run AI-powered job-profile matching, and manage your application pipeline.

## Architecture

```
Frontend (React/Vite)  ──WebSocket──►  API Server (FastAPI)  ──Redis──►  Worker (arq)
         │                                    │                              │
         └──── REST API ──────────────────────┘                              │
                                              │                              │
                                         PostgreSQL  ◄───────────────────────┘
```

**API Server** — FastAPI app handling REST endpoints, authentication (JWT), and WebSocket connections for real-time progress updates.

**Worker** — arq background worker that processes extraction and AI match analysis jobs. Publishes progress events to Redis pub/sub for WebSocket delivery.

**Frontend** — React SPA with real-time WebSocket updates (no polling), job list management, profile editor, and AI match score display.

### Extraction Pipeline

Multi-strategy extraction with automatic fallback:

1. **Ashby API** — Direct public API call (no HTML needed)
2. **Greenhouse Board API** — Detects and uses Greenhouse endpoints
3. **JSON-LD** — Parses `schema.org/JobPosting` structured data
4. **Static HTML** — Readability + CSS selector extraction
5. **Browser Rendering** — Playwright for SPAs and dynamic content

Extracted data feeds directly into `JobDescriptionSchema` — no intermediate AI parsing step. OpenAI is used only for job-profile match analysis (not extraction).

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

All three processes must run for full functionality:

```bash
# 1. API server (port 8000)
python start_server.py

# 2. Background worker (processes extraction and match jobs)
python run_worker.py

# 3. Frontend dev server (port 5173)
cd frontend && npm run dev
```

Jobs stay in "pending" status until the worker picks them up. The frontend receives real-time updates via WebSocket — no manual refresh needed.

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

A `render.yaml` Blueprint is included for Render.com deployment (API server, worker, static frontend, Redis key-value store). Database is external (e.g. Neon PostgreSQL).
