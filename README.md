# Atomspace / Job Scraper — Setup Guide

This guide gets the app installed and running end to end. It does not cover architecture.

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

> **Windows tip:** Prefer a path **without** renaming/moving the folder after creating the venv. If you already moved it, see [Troubleshooting](#troubleshooting).

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

Confirm the venv is active:

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

| Variable | What to put |
|----------|-------------|
| `DATABASE_URL` | Your Postgres URL (asyncpg form above) |
| `REDIS_URL` | `redis://localhost:6379/0` |
| `AUTH_SECRET_KEY` | Long random string (JWT signing) |
| `OPENAI_API_KEY` | Your key (can be a placeholder until you use AI features) |

Optional:

- `OPENAI_API_BASE` — custom OpenAI-compatible gateway
- `GOOGLE_SHEETS_CREDENTIALS_PATH` — path to service-account JSON
- `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` — only if you scrape Adzuna

Keep `APP_ENV=local` for development.

---

## 6. Database migrations

With the venv active and Postgres running:

```bash
alembic upgrade head
```

This creates all tables. Run it again after pulling new migrations.

---

## 7. Frontend packages

```bash
cd frontend
npm install
cd ..
```

---

## 8. Start everything

### Windows (recommended)

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
# Terminal 1 — API
python start_server.py

# Terminal 2 — Extraction
python run_worker.py extraction

# Terminal 3 — Analysis
python run_worker.py analysis

# Terminal 4 — Tailoring
python run_worker.py tailoring

# Terminal 5 — Save
python run_worker.py save

# Terminal 6 — Resume builds
python run_worker.py resume

# Terminal 7 — Scraper / Sync
python run_worker.py scraper

# Terminal 8 — Frontend
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

1. Open the frontend.
2. **Sign up** with email + password.  
   The **first account** is created as an **admin** automatically.
3. Sign in if needed.
4. Fill **Profile**, then use **Jobs** / **Resume Builder** / **Integrations** as needed.
5. Admins: open **System Settings** to bind LLM keys/models and worker concurrency.

PostgreSQL and Redis must stay running while you use the app.

---

## Optional: scraper platform login

Some Sync platforms need a saved browser session (cookies on disk):

```bash
# RemoteRocketship
python -m app.scraper.auth setup rrs

# Jobright
python -m app.scraper.auth setup jobright
```

A headed browser opens — log in once, then close when prompted. If Sync returns auth/403 errors later, run the same command again to refresh the session.

---

## Optional: browser extension

See [`extension/README.md`](extension/README.md) to load the unpacked Chrome/Edge extension after the API is running.

---

## Optional: LAN access (other devices on Wi‑Fi)

1. Start with `start.cmd` (it prints a LAN frontend URL).
2. On the host PC (Admin PowerShell), allow port 5173 once:

```powershell
.\scripts\open_lan_firewall.ps1
```

3. On other devices, open only the **frontend** LAN URL (port **5173**), not `:8000`.

---

## Troubleshooting

### `Python was not found` (Windows Store message)

Your shell is hitting the Store stub, or the venv points at an **old folder path**.

- Prefer: `.\venv\Scripts\python.exe ...`
- Or re-create the venv in the current folder:

```cmd
rmdir /s /q venv
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### Port 8000 already in use

Close old API windows, or run `start.cmd` again (it tries to stop prior `start_server.py` / `run_worker.py` processes).

### `alembic` / DB connection errors

- Postgres is running.
- Database `job_scraper` exists.
- `DATABASE_URL` user/password/host match your install.
- URL uses `postgresql+asyncpg://...` (not `postgresql://` alone for the app).

### Workers idle / jobs stuck in Queued

All **seven** worker modes must be running (extraction, analysis, tailoring, save, resume, scraper) plus the API. Redis must be up.

### RemoteRocketship Sync fails with 403

Session expired. Re-run:

```bash
python -m app.scraper.auth setup rrs
```

Then restart the scraper worker (or run `start.cmd` again).

### AI features fail / empty model responses

In **System Settings**, set a valid provider API key and job→model bindings. Restart workers after changing concurrency settings.

### Frontend can’t reach API

- API window is running on `:8000`.
- Open http://localhost:5173 (Vite proxies `/api`).
- Check `VITE_API_PROXY_TARGET` only if you changed the API host/port.

---

## Quick checklist

- [ ] Python 3.12+, Node 18+, Postgres, Redis installed  
- [ ] `venv` created + `pip install -r requirements.txt`  
- [ ] `playwright install chromium`  
- [ ] `.env` copied from `env.example` and filled in  
- [ ] `CREATE DATABASE job_scraper;`  
- [ ] `alembic upgrade head`  
- [ ] `cd frontend && npm install`  
- [ ] `start.cmd` (or 8 manual terminals)  
- [ ] Sign up at http://localhost:5173 (first user = admin)  
