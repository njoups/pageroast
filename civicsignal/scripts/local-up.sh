#!/usr/bin/env bash
# Starts CivicSignal on this laptop with Docker (macOS, Linux, or Windows via WSL/Git Bash). Guide: docs/LOCAL_SETUP.md
#   bash scripts/local-up.sh            # first run builds the images (several minutes), later runs reuse them
#   bash scripts/local-up.sh --no-build # start with images that are already built
# Creates .env with random local-only secrets the first time (never commit it), starts every service, waits until all
# health checks pass and prints the addresses. Stop: docker compose stop. Remove everything incl. data: docker compose down -v
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop, wait until it says 'running', then run this again."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing. Update Docker Desktop."

# Random values without openssl (od/base64 read a fixed number of bytes, so no SIGPIPE under pipefail).
rand_hex() { od -An -tx1 -N "$(( $1 / 2 ))" /dev/urandom | tr -d ' \n'; }
rand_b64_32() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }
free_port() { local p=$1; while port_busy "$p"; do p=$((p + 1)); done; echo "$p"; }
set_var() { # set_var NAME VALUE: replace "NAME=..." in .env or append it
  if grep -q "^$1=" .env; then sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

if [ ! -f .env ]; then
  say "Creating .env with random local secrets"
  umask 077
  cp .env.example .env
  set_var POSTGRES_PASSWORD "$(rand_hex 48)"
  set_var APP_DB_PASSWORD "$(rand_hex 48)"
  set_var REDIS_PASSWORD "$(rand_hex 48)"
  set_var CREDENTIALS_KEY "$(rand_b64_32)"
  set_var METRICS_TOKEN "$(rand_hex 64)"
  set_var APP_ENV local
  # Ports: use the defaults, or the next free ones if something else (e.g. a local Postgres) already uses them.
  web=$(free_port 3000); db=$(free_port 5432); mail=$(free_port 8025)
  set_var WEB_HOST_PORT "$web"; set_var DB_HOST_PORT "$db"; set_var MAIL_HOST_PORT "$mail"
  set_var APP_ORIGINS "http://localhost:$web"; set_var APP_BASE_URL "http://localhost:$web"
else
  say "Using the existing .env"
fi
web=$(grep '^WEB_HOST_PORT=' .env | cut -d= -f2 || true); web=${web:-3000}
mail=$(grep '^MAIL_HOST_PORT=' .env | cut -d= -f2 || true); mail=${mail:-8025}

build_flag="--build"   # a plain string: empty arrays break under set -u in macOS's bash 3.2
[ "${1:-}" = "--no-build" ] && build_flag=""
say "Starting CivicSignal (the first build downloads dependencies and can take 5-10 minutes)"
# shellcheck disable=SC2086 # build_flag is intentionally unquoted (empty or one word)
docker compose up -d $build_flag --wait --wait-timeout 300 || {
  docker compose ps
  die "Some services did not become healthy. Logs: docker compose logs --tail 50 api worker web"
}

say "CivicSignal is running"
cat <<EOF
  App:        http://localhost:$web        (use Chrome, Edge or Firefox)
  Email inbox: http://localhost:$mail       (alerts, reports and password-reset emails arrive here)

  Next: open the app, click Register, create your organization, then follow docs/LOCAL_SETUP.md
  (add news sources, a project with keywords, alerts and a report).

  Make yourself a platform administrator (optional, for the /platform console):
    docker compose run --rm migrate node apps/api/dist/database/promote-platform-admin-cli.js you@example.com
  Stop:            docker compose stop          (data is kept)
  Start again:     bash scripts/local-up.sh --no-build
  Delete all data: docker compose down -v
EOF
