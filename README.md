# NAO

Production: https://atomspace.it.com/

API and SPA are same-origin (nginx serves `frontend/dist` and proxies `/api` to FastAPI).
Deploy: push to `main` → GitHub Actions SSHs to the VPS (`/opt/showerv3`).

See `env.example` for environment variables. Extension default backend is
`https://atomspace.it.com` in `extension/config.js`.

Nginx site files live in `deploy/nginx/`. `atomspace.it.com` (plus its `www`
twin) is the only site served; any other Host is refused by the catch-all block,
so retired domains still pointed at the box get nothing.

## Local development (WSL2)

The full stack runs inside WSL2 Ubuntu 24.04: Redis and Postgres in Docker
(`docker-compose.laptop.yml`), and the API, eight arq workers and Vite under a
user-level supervisord (`deploy/supervisor/nao-wsl.conf`). Embeddings run on the
GPU (CUDA) in the `encoding` worker only.

Keep the repo on the Linux filesystem (`~/NAO`), not `/mnt/<drive>`; file I/O
across the Windows mount is several times slower.

### First-time setup

Windows prerequisites (WSL2, Docker Desktop with Ubuntu integration, NVIDIA
driver, `.wslconfig`) are listed in the header of `scripts/wsl-stack.sh`.

```bash
bash scripts/wsl-bootstrap.sh     # idempotent: apt, uv, Python, CUDA torch, Playwright, Node, npm ci
nano .env.wsl                     # set AUTH_SECRET_KEY, SETTINGS_ENCRYPTION_KEY, OPENAI_API_KEY
bash scripts/wsl-stack.sh up
```

`.env.wsl` is gitignored and overrides `.env` / `.env.local`. Keep a copy of
`SETTINGS_ENCRYPTION_KEY`; stored provider keys cannot be decrypted without it.

### Daily use

Start Docker Desktop first, then from `~/NAO`:

| Task | Command |
|---|---|
| Start everything (DB, migrations, all programs) | `bash scripts/wsl-stack.sh up` |
| Status of containers and programs | `bash scripts/wsl-stack.sh status` |
| Follow logs (all, or one program) | `bash scripts/wsl-stack.sh logs [name]` |
| Restart one program | `bash scripts/wsl-stack.sh restart <name>` |
| Restart the whole app stack | `bash scripts/wsl-stack.sh restart` |
| Start the optional second analysis worker | `bash scripts/wsl-stack.sh start analysis2` |
| Stop programs (keep Redis/Postgres) | `bash scripts/wsl-stack.sh stop` |
| Stop everything, including containers | `bash scripts/wsl-stack.sh stop --all` |

Programs: `api` `extraction` `encoding` `analysis` `analysis2` `save`
`tailoring` `resume` `scraper` `autopost` `vite`. Logs are in `.run/logs/`.

- Dashboard: http://127.0.0.1:5173 · API: http://127.0.0.1:8000 (docs at `/docs`)
- Workers do not auto-reload. After editing Python code or `.env.wsl`, restart
  the affected program. Vite hot-reloads the frontend.
- GPU check: `bash scripts/wsl-stack.sh logs encoding` should show
  `embedding_model_loaded ... device=cuda`.

### Troubleshooting

- **`docker daemon unreachable`** — start Docker Desktop; confirm Ubuntu-24.04
  is enabled under *Resources → WSL integration*. After `wsl --shutdown`,
  restart Docker Desktop.
- **A program is `FATAL` / `BACKOFF`** — `bash scripts/wsl-stack.sh logs <name>`;
  most often a bad value in `.env.wsl`.
- **Laptop memory pressure** — lower `EXTRACTION_WORKER_MAX_JOBS` and
  `BROWSER_POOL_SIZE` together in `.env.wsl` (Chromium is the largest consumer).
