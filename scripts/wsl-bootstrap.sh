#!/usr/bin/env bash
# Idempotent inside-WSL install for the NAO laptop stack (Ubuntu 24.04).
# Safe to re-run; each step skips when already satisfied. Uses sudo for apt only.
#
#   scripts/wsl-bootstrap.sh
#
# Overrides: TORCH_INDEX (default cu124 wheels), PY_VERSION (default .python-version).
# See the header of scripts/wsl-stack.sh for the Windows-side prerequisites.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$NAO_ROOT"

TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu124}"
PY_VERSION="${PY_VERSION:-$(tr -d '[:space:]' < .python-version 2>/dev/null || echo 3.12)}"
NODE_MAJOR=22
VENV_PY="$NAO_ROOT/.venv/bin/python"

log() { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }

case "$NAO_ROOT" in
  /mnt/*) warn "repo is on $NAO_ROOT (Windows drive via 9p): works, but pip/npm/alembic are much slower than ~/NAO" ;;
esac

# --- apt ---------------------------------------------------------------------
APT_PKGS=(build-essential git curl ca-certificates supervisor htop btop nvtop)
missing=()
for p in "${APT_PKGS[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if ((${#missing[@]})); then
  log "apt install: ${missing[*]}"
  sudo apt-get update
  sudo apt-get install -y "${missing[@]}"
else
  log "apt packages present"
fi
# The apt package enables a system-wide supervisord; wsl-stack.sh runs its own.
if systemctl is-enabled supervisor >/dev/null 2>&1; then
  log "disabling system supervisor service (not used)"
  sudo systemctl disable --now supervisor || true
fi

# --- uv + Python -------------------------------------------------------------
export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  log "installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
log "uv python install $PY_VERSION"
uv python install "$PY_VERSION"

if [[ -d .venv && ! -x "$VENV_PY" ]]; then
  die ".venv exists but has no bin/python (Windows venv?) — remove it and re-run"
fi
if [[ ! -x "$VENV_PY" ]]; then
  log "creating .venv (Python $PY_VERSION)"
  uv venv --python "$PY_VERSION" .venv
fi

# --- CUDA torch BEFORE requirements -----------------------------------------
if "$VENV_PY" -c "import sys, torch; sys.exit(0 if torch.version.cuda else 1)" >/dev/null 2>&1; then
  log "CUDA torch already installed"
else
  log "installing torch from $TORCH_INDEX"
  uv pip install --python "$VENV_PY" torch --index-url "$TORCH_INDEX"
fi

log "installing requirements.txt"
uv pip install --python "$VENV_PY" -r requirements.txt

if ! "$VENV_PY" -c "import sys, torch; sys.exit(0 if torch.version.cuda else 1)" >/dev/null 2>&1; then
  warn "torch is no longer a CUDA build after requirements — reinstalling from $TORCH_INDEX"
  uv pip install --python "$VENV_PY" --reinstall-package torch torch --index-url "$TORCH_INDEX"
fi

# --- Playwright --------------------------------------------------------------
log "playwright OS deps + chromium"
sudo "$VENV_PY" -m playwright install-deps chromium
"$VENV_PY" -m playwright install chromium

# --- Node 22 + frontend ------------------------------------------------------
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if [[ "$(node_major || true)" != "$NODE_MAJOR" ]]; then
  log "installing Node $NODE_MAJOR (NodeSource apt, so supervisord finds it in /usr/bin)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# node_modules is shared with Windows when the repo is on /mnt/*; npm ci swaps
# in Linux-native binaries (esbuild/rollup), so Windows-side Vite needs its own npm ci after.
stamp="frontend/node_modules/.nao-wsl-stamp"
if [[ ! -f "$stamp" || frontend/package-lock.json -nt "$stamp" ]]; then
  log "npm ci (frontend)"
  (cd frontend && npm ci)
  touch "$stamp"
else
  log "frontend node_modules up to date"
fi

# --- env file ----------------------------------------------------------------
if [[ ! -f .env.wsl ]]; then
  cp env.wsl.example .env.wsl
  warn "created .env.wsl from env.wsl.example — set AUTH_SECRET_KEY and OPENAI_API_KEY"
fi

# --- verify ------------------------------------------------------------------
log "verifying"
nvidia-smi -L || warn "nvidia-smi failed — check the Windows NVIDIA driver / WSL2 GPU support"
"$VENV_PY" - <<'PY' || warn "torch CUDA check failed (encoding falls back to CPU)"
import torch
print("torch", torch.__version__, "cuda", torch.version.cuda, "available", torch.cuda.is_available())
if torch.cuda.is_available():
    print("device", torch.cuda.get_device_name(0))
PY
docker info >/dev/null 2>&1 || warn "docker unreachable — enable Docker Desktop WSL integration for this distro"
log "done. Next: scripts/wsl-stack.sh up"
