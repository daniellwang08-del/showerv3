# Atomspace

Production: https://robertstaff.com/

API and SPA are same-origin (nginx serves `frontend/dist` and proxies `/api` to FastAPI).  
Deploy: push to `main` → GitHub Actions SSHs to the VPS (`/opt/showerv3`).

See `env.example` for environment variables. Extension default backend is
`https://robertstaff.com` in `extension/config.js`.
