#!/usr/bin/env bash
# `pnpm dev` — the only command you need. Idempotent: every step is a fast no-op when
# nothing changed. Brings up everything, then runs worker + web in this terminal.
#
#   pnpm dev                    # setup + run
#   pnpm dev -- --setup-only    # setup, do not start worker/web
#   pnpm dev -- --rebuild-images
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SETUP_ONLY=0
REBUILD_IMAGES=0
for a in "$@"; do
  case "$a" in
    --setup-only) SETUP_ONLY=1 ;;
    --rebuild-images) REBUILD_IMAGES=1 ;;
  esac
done

step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

# ── docker reachable? (fresh shells may not be in the docker group yet) ──────
if ! docker info >/dev/null 2>&1; then
  if getent group docker | grep -qw "$USER" && ! id -nG | grep -qw docker; then
    exec sg docker -c "bash $0 $*"
  fi
  if ! command -v docker >/dev/null; then
    echo "docker is not installed. See README → Requirements." >&2
    exit 1
  fi
  echo "docker daemon not reachable. Try: sudo systemctl start docker" >&2
  exit 1
fi

# ── .env ────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  step ".env (created from .env.example with generated secrets)"
  cp .env.example .env
  sed -i "s|^BYOK_KEK=.*|BYOK_KEK=$(openssl rand -hex 32)|" .env
  echo "  fill ATTESTER_KEYPAIR_PATH / GITHUB_DISPATCH_TOKEN in .env when you need them"
fi

# ── corpus submodule ────────────────────────────────────────────────────────
if [ ! -f vendor/auditor-skill/.claude-plugin/plugin.json ]; then
  step "corpus submodule"
  git submodule update --init vendor/auditor-skill
fi
[ "$(git -C vendor/auditor-skill rev-parse HEAD)" = "8ecccb4a4013d296c1798ba279c1af605f47d317" ] || { echo "vendor/auditor-skill is not at 8ecccb4" >&2; exit 1; }

# ── dependencies ────────────────────────────────────────────────────────────
step "dependencies"
pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -1

# ── postgres ────────────────────────────────────────────────────────────────
step "postgres"
docker compose up -d postgres 2>&1 | tail -1
for i in $(seq 1 40); do docker compose exec -T postgres pg_isready -U auditor -d auditor >/dev/null 2>&1 && break; sleep 1; done
docker compose exec -T postgres pg_isready -U auditor -d auditor >/dev/null 2>&1 || { echo "postgres did not become ready" >&2; exit 1; }

# ── prisma + migrations ─────────────────────────────────────────────────────
step "database"
pnpm --filter @auditor/db generate 2>&1 | grep -E 'Generated|error' || true
pnpm --filter @auditor/db migrate:deploy 2>&1 | grep -E 'applied|No pending|error|Error' || true

# ── shared packages (web + worker import their dist/) ───────────────────────
step "packages"
pnpm -r --filter './packages/**' --filter '!@auditor/db' build 2>&1 | grep -E 'error|Failed' || true

# ── sandbox images (only when missing or --rebuild-images) ──────────────────
step "sandbox images"
if [ "$REBUILD_IMAGES" = 1 ] || ! docker image inspect auditor-egress-proxy:latest >/dev/null 2>&1; then
  docker build -q -t auditor-egress-proxy:latest -f sandbox/egress-proxy/Dockerfile sandbox/egress-proxy >/dev/null && echo "  auditor-egress-proxy:latest built"
else
  echo "  auditor-egress-proxy:latest present"
fi
if [ "$REBUILD_IMAGES" = 1 ] || ! docker image inspect auditor-sandbox:latest >/dev/null 2>&1; then
  echo "  building auditor-sandbox:latest (a few minutes the first time)…"
  docker build -q -t auditor-sandbox:latest -f sandbox/Dockerfile . >/dev/null && echo "  auditor-sandbox:latest built"
else
  echo "  auditor-sandbox:latest present (pnpm dev -- --rebuild-images to rebuild)"
fi

# ── hand-run example audits → site (idempotent upsert by owner/repo/commit) ─────
if [ -d "examples i runned local" ]; then
  step "example audits"
  EXAMPLES_MODEL="$(grep -E '^EXAMPLES_MODEL=' .env | cut -d= -f2- | tr -d '[:space:]' || true)"
  if [ -n "$EXAMPLES_MODEL" ]; then
    pnpm exec tsx scripts/ingest-examples.ts --model "$EXAMPLES_MODEL" --visibility "${EXAMPLES_VISIBILITY:-public}" 2>&1 | grep -vE 'injected env|^\s*$' | tail -4
  else
    echo "  skipped: set EXAMPLES_MODEL in .env (the model those audits were run with) to publish them"
  fi
fi

if [ "$SETUP_ONLY" = 1 ]; then
  echo; echo "setup complete."; exit 0
fi

# ── run ─────────────────────────────────────────────────────────────────────
step "starting worker + web  (Ctrl+C stops both)"
trap 'echo; echo "stopping…"; kill 0 2>/dev/null' INT TERM EXIT
pnpm --filter @auditor/worker dev 2>&1 | sed -u 's/^/[worker] /' &
pnpm --filter @auditor/web dev 2>&1 | sed -u 's/^/[web]    /' &
wait
