# Job Scraper

## Prerequisites

Install these before setup:

| Tool | Version | Notes |
|------|---------|--------|
| Python | 3.12+ | Backend, workers, Scrapy |
| Node.js | 18+ | Frontend (`frontend/`) |
| PostgreSQL | 14+ | Main database |
| Redis | 6+ | Job queues (use [Memurai](https://www.memurai.com/) on Windows) |

Optional but recommended:

- **Playwright browsers** - SPA extraction and Scrapy Playwright spiders  
  `playwright install chromium`

PDF export uses the pure-Python **`dxpdf`** package (`pip install` via `requirements.txt`). No LibreOffice / MS Office install is required.

---

## Install

### 1. Clone and enter the project

```bash
git clone <your-repo-url>
cd job_scraper
```

### 2. Backend (Python)

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

### 3. Environment file

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
| `DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5432/job_scraper` |
| `REDIS_URL` | `redis://localhost:6379/0` |
| `OPENAI_API_KEY` | Your OpenAI key |
| `AUTH_SECRET_KEY` | Long random string for JWT signing |

Create the PostgreSQL database if it does not exist, then run migrations:

```bash
alembic upgrade head
```

### 4. Frontend

```bash
cd frontend
npm install
cd ..
```

---

## Run

The app needs **one API server**, **five workers**, and **one frontend dev server**.

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
# 1. API (http://localhost:8000)
python start_server.py

# 2. Extraction worker (URL scraping)
python run_worker.py extraction

# 3. Analysis worker (Phase A match scoring)
python run_worker.py analysis

# 4. Tailoring worker (Phase B resume tailoring — dedicated queue)
python run_worker.py tailoring

# 5. Save worker (post-analysis persistence + auto-post)
python run_worker.py save

# 6. Resume build worker (DOCX/PDF generation)
python run_worker.py resume

# 7. Scraper worker (platform sync / Scrapy)
python run_worker.py scraper

# 8. Frontend (http://localhost:5173)
cd frontend && npm run dev
```

### URLs

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| API | http://localhost:8000 |
| API docs | http://localhost:8000/docs |

Ensure PostgreSQL and Redis are running before starting the backend.
