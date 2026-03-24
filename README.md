# Job Scraper

## Setup

```bash
# Backend
python -m venv venv
venv\Scripts\activate   # Windows
# source venv/bin/activate   # macOS/Linux
pip install -r requirements.txt

# Copy env and set DATABASE_URL, REDIS_URL, OPENAI_API_KEY (optional), AUTH_SECRET_KEY
copy env.example .env

# Optional: Browser extraction (Playwright) - for SPAs that need JS rendering
# Ashby jobs use the public API (no browser needed). Run only if you need browser fallback for other sites:
# playwright install

# Migrations
alembic upgrade head

# Frontend
cd frontend
npm install
```

## Run

**All three must run for full functionality:**

```bash
# 1. API server (port 8000)
python start_server.py

# 2. Worker (processes jobs from queue - REQUIRED for async job extraction)
#    Uses Redis or Memurai (Redis-compatible). Default: redis://localhost:6379/0
python run_worker.py

# 3. Frontend (port 5173)
cd frontend && npm run dev
```

**Note:** Jobs stay "pending" until the worker processes them. If using Memurai instead of Redis, set `REDIS_URL` in `.env` (e.g. `redis://localhost:6379/0`).

## Test

```bash
pytest
```
