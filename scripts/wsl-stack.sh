#!/usr/bin/env bash
# =============================================================================
# NAO full stack inside WSL2 Ubuntu 24.04 (Redis + Postgres in Docker, API +
# 8 arq workers + Vite under a user-level supervisord). No root needed to run.
#
#   scripts/wsl-stack.sh up                 # docker db up, alembic upgrade, start all
#   scripts/wsl-stack.sh status
#   scripts/wsl-stack.sh logs [name]        # tail one program (or all) from .run/logs
#   scripts/wsl-stack.sh restart [name]     # one program, or the whole app stack
#   scripts/wsl-stack.sh start|stop <name>  # e.g. start analysis2 (optional 2nd analysis)
#   scripts/wsl-stack.sh stop [--all]       # stop supervisord; --all also stops containers
#
# Programs: api extraction encoding analysis analysis2 save tailoring resume
#           scraper autopost vite   (config: deploy/supervisor/nao-wsl.conf)
# Env:      .env.wsl (copy env.wsl.example). Logs: .run/logs/<program>.log
# Repo can live at ~/NAO (fast, recommended) or /mnt/d/Project/NAO (slow 9p I/O).
#
# -----------------------------------------------------------------------------
# Phase 0 install list
# -----------------------------------------------------------------------------
# Windows host (do first):
#   1. wsl --install -d Ubuntu-24.04   (admin; enable virtualization in BIOS if it fails)
#   2. Windows Terminal (Store).
#   3. NVIDIA driver: keep the Windows driver (596.x). Do NOT install a Windows
#      CUDA toolkit; WSL uses the Windows driver + Linux user-space.
#   4. Docker Desktop: WSL2 engine on, Ubuntu-24.04 integration on, memory ~2 GB.
#   5. (Optional, Phase 3) Intel NPU driver. Not needed for CUDA.
#   6. C:\Users\<you>\.wslconfig, then `wsl --shutdown`:
#        [wsl2]
#        memory=10GB
#        processors=16
#        swap=16GB
#        localhostForwarding=true
#   Do not install on Windows: VS Build Tools, CUDA toolkit, Ollama, a worker venv.
#
# Inside Ubuntu (scripts/wsl-bootstrap.sh does all of this idempotently):
#   - apt: build-essential git curl ca-certificates supervisor htop btop nvtop
#   - uv:  curl -LsSf https://astral.sh/uv/install.sh | sh
#   - Python 3.12 via uv, venv at .venv:  uv python install 3.12 && uv venv --python 3.12 .venv
#   - CUDA torch wheel BEFORE requirements (else sentence-transformers pulls a default build):
#       uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cu124
#       uv pip install --python .venv/bin/python -r requirements.txt
#   - Playwright: sudo .venv/bin/python -m playwright install-deps chromium
#                 .venv/bin/python -m playwright install chromium
#   - Node 22 LTS (frontend wants ^20.19 || ^22.12), then `npm ci` in frontend/
#   - Verify GPU: nvidia-smi -L ; .venv/bin/python -c "import torch; print(torch.cuda.get_device_name(0))"
# Not needed: vLLM, TensorRT-LLM, Ollama, Postgres GUIs.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export NAO_ROOT

# AF_UNIX sockets cannot live on /mnt/<drive> (drvfs), so the supervisor
# socket/pid go on the Linux filesystem, keyed by repo path.
_root_hash="$(printf '%s' "$NAO_ROOT" | md5sum | cut -c1-8)"
NAO_RUN_DIR="${NAO_RUN_DIR:-${XDG_RUNTIME_DIR:-/tmp}/nao-$(id -u)-$_root_hash}"
export NAO_RUN_DIR

CONF="$NAO_ROOT/deploy/supervisor/nao-wsl.conf"
ENV_FILE="${NAO_ENV_FILE:-$NAO_ROOT/.env.wsl}"
LOG_DIR="$NAO_ROOT/.run/logs"
VENV_DIR="$NAO_ROOT/.venv"
SOCK="$NAO_RUN_DIR/supervisor.sock"
PIDFILE="$NAO_RUN_DIR/supervisord.pid"
COMPOSE=(docker compose
  -f "$NAO_ROOT/docker-compose.yml"
  -f "$NAO_ROOT/docker-compose.laptop.yml"
  --profile docker-db)

log() { printf '\033[1;34m[nao]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[nao]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '6,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

load_env() {
  [[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE — run: cp env.wsl.example .env.wsl (then fill secrets)"
  set -a
  # Strip CRLF in case the file was edited on the Windows side.
  # shellcheck disable=SC1090
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
}

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found — $2"; }

preflight() {
  need docker "enable Docker Desktop WSL integration for this distro"
  need supervisord "run scripts/wsl-bootstrap.sh (apt install supervisor)"
  need npm "install Node 22 (scripts/wsl-bootstrap.sh)"
  [[ -x "$VENV_DIR/bin/python" ]] || die "no $VENV_DIR/bin/python — run scripts/wsl-bootstrap.sh"
  docker info >/dev/null 2>&1 || die "docker daemon unreachable — start Docker Desktop"
}

ctl() { supervisorctl -c "$CONF" -s "unix://$SOCK" "$@"; }

supervisord_running() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

require_running() {
  supervisord_running || die "supervisord is not running — scripts/wsl-stack.sh up"
}

wait_for_socket() {
  local i
  for i in $(seq 1 50); do
    [[ -S "$SOCK" ]] && return 0
    sleep 0.2
  done
  die "supervisord did not create $SOCK (see $LOG_DIR/supervisord.log)"
}

cmd_up() {
  preflight
  load_env
  mkdir -p "$LOG_DIR" "$NAO_RUN_DIR"
  chmod 700 "$NAO_RUN_DIR"

  log "starting redis + postgres (laptop overlay), waiting for health"
  "${COMPOSE[@]}" up -d --wait --wait-timeout 120 redis postgres

  log "alembic upgrade head"
  (cd "$NAO_ROOT" && "$VENV_DIR/bin/python" -m alembic upgrade head)

  if supervisord_running; then
    log "supervisord already running — applying config and starting autostart programs"
    ctl update
    ctl start api extraction encoding analysis save tailoring resume scraper autopost vite || true
  else
    log "starting supervisord"
    rm -f "$SOCK"
    supervisord -c "$CONF"
    wait_for_socket
  fi
  sleep 3
  ctl status || true
  log "dashboard: http://127.0.0.1:5173   api: http://127.0.0.1:8000   logs: $LOG_DIR"
}

cmd_status() {
  "${COMPOSE[@]}" ps redis postgres || true
  echo
  if supervisord_running; then
    ctl status || true
  else
    log "supervisord not running"
  fi
}

cmd_stop() {
  local name="${1:-}"
  if [[ -n "$name" && "$name" != "--all" ]]; then
    require_running
    ctl stop "$name"
    return
  fi
  if supervisord_running; then
    log "stopping supervisord (graceful; extraction/scraper may take up to 2 min)"
    local pid
    pid="$(cat "$PIDFILE")"
    ctl shutdown || kill -TERM "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 1; done
    log "supervisord stopped"
  else
    log "supervisord not running"
  fi
  if [[ "$name" == "--all" ]]; then
    load_env
    log "stopping redis + postgres"
    "${COMPOSE[@]}" stop redis postgres
  fi
}

cmd_start() {
  [[ -n "${1:-}" ]] || die "usage: wsl-stack.sh start <name>"
  require_running
  ctl start "$1"
}

cmd_restart() {
  local name="${1:-}"
  if [[ -n "$name" ]]; then
    require_running
    ctl restart "$name"
  else
    cmd_stop
    cmd_up
  fi
}

cmd_logs() {
  local name="${1:-}"
  if [[ -n "$name" ]]; then
    local f="$LOG_DIR/$name.log"
    [[ -f "$f" ]] || die "no log at $f"
    exec tail -n 200 -F "$f"
  fi
  shopt -s nullglob
  local files=("$LOG_DIR"/*.log)
  ((${#files[@]})) || die "no logs in $LOG_DIR yet"
  exec tail -n 20 -F "${files[@]}"
}

# Internal: supervisor program entrypoint. Fresh .env.wsl on every (re)start.
cmd_run() {
  [[ $# -gt 0 ]] || die "usage: wsl-stack.sh run <command...>"
  cd "$NAO_ROOT"
  load_env
  export VIRTUAL_ENV="$VENV_DIR"
  export PATH="$VENV_DIR/bin:$HOME/.local/bin:$PATH"
  export PYTHONUNBUFFERED=1
  exec "$@"
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    up) cmd_up ;;
    status) cmd_status ;;
    stop) cmd_stop "$@" ;;
    start) cmd_start "$@" ;;
    restart) cmd_restart "$@" ;;
    logs) cmd_logs "$@" ;;
    run) cmd_run "$@" ;;
    -h | --help | help | "") usage ;;
    *) usage; die "unknown command: $cmd" ;;
  esac
}

main "$@"
