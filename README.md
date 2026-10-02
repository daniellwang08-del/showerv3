# NAO

Production: https://atomspace.it.com/

API and SPA are same-origin (nginx serves `frontend/dist` and proxies `/api` to FastAPI).
Deploy: push to `main` → GitHub Actions SSHs to the VPS (`/opt/showerv3`).

See `env.example` for environment variables. Extension default backend is
`https://atomspace.it.com` in `extension/config.js`.

Nginx site files live in `deploy/nginx/`. `atomspace.it.com` (plus its `www`
twin) is the only site served; any other Host is refused by the catch-all block,
so retired domains still pointed at the box get nothing.
