#!/usr/bin/env bash
# Disposable end-to-end test of the production deployment files (infra/compose.production.yml + Caddyfile.production)
# with the given images, in staging mode, on this machine only:
#   API_IMAGE=civicsignal-api:ci WEB_IMAGE=civicsignal-web:ci scripts/stack-test.sh
#
# 1. generates throwaway secrets in a private temp dir (never printed);
# 2. starts PostgreSQL and Redis (selfhosted-data profile), runs the one-shot migrate job, starts api, worker, web and
#    the TLS edge (Caddy's internal CA for "localhost") and waits for every health check;
# 3. checks container hardening (non-root, read-only root fs, no capabilities, only the edge publishes ports);
# 4. creates a synthetic smoke-test account and runs scripts/smoke.mjs over HTTPS;
# 5. takes an encrypted backup (throwaway GPG key) and runs the restore drill, then checks the live API is unaffected;
# 6. checks graceful shutdown and that no generated secret appears in any container log;
# 7. removes the stack, its volumes and the temp dir (KEEP_STACK=1 keeps them for inspection).
# Needs: docker compose v2, node 22 with the repository's dependencies installed (npm ci: the restore drill runs
# migrations), openssl, gpg, pg_dump/psql 16, python3. Uses ports 80 and 443.
set -euo pipefail
: "${API_IMAGE:?set API_IMAGE}" "${WEB_IMAGE:?set WEB_IMAGE}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"; chmod 700 "$work"
project="cs-stacktest-$$"
C=(docker compose -p "$project" --env-file "$work/compose.env" -f "$repo/infra/compose.production.yml" --profile selfhosted-data)
fail() {
  echo "STACK TEST FAILED: $*" >&2
  "${C[@]}" ps -a >&2 || true
  "${C[@]}" logs --no-color --tail 30 api worker web migrate db >&2 || true   # not the edge: its access log lines are huge
  echo "STACK TEST FAILED: $*" >&2                                            # repeated so it is the last line in CI logs
  exit 1
}
cleanup() { if [ "${KEEP_STACK:-0}" != 1 ]; then "${C[@]}" --profile migrate down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$work"; else echo "kept: project $project, files $work"; fi; }
trap cleanup EXIT

umask 077
rand() { openssl rand -hex "$1"; }
pg=$(rand 24); rp=$(rand 24); ap=$(rand 24); metrics=$(rand 32); smoke_pw=$(rand 16)
printf '%s' "$pg" > "$work/postgres_password"; printf '%s' "$rp" > "$work/redis_password"
cat > "$work/app.env" <<EOF
APP_ENV=staging
NODE_ENV=production
APP_ORIGINS=https://localhost
APP_BASE_URL=https://localhost
COOKIE_SECURE=true
TRUST_PROXY=true
DATABASE_URL=postgres://civicsignal_app:$ap@db:5432/civicsignal
REDIS_URL=redis://:$rp@redis:6379/0
SMTP_URL=smtp://smtp.invalid:25
EMAIL_FROM=alerts@civicsignal.invalid
NOTIFY_ALLOWED_EMAIL_DOMAINS=civicsignal.invalid
AI_PROVIDER=baseline
BILLING_PROVIDER=test
EOF
# Generated at run time, never literal values; written with printf so the secret scanner's NAME=value rule stays meaningful.
printf 'CREDENTIALS_KEY=%s\nMETRICS_TOKEN=%s\nBILLING_TEST_WEBHOOK_SECRET=%s\n' "$(openssl rand -base64 32)" "$metrics" "$(rand 24)" >> "$work/app.env"
printf 'NODE_ENV=production\nMIGRATION_DATABASE_URL=postgres://civicsignal_owner:%s@db:5432/civicsignal\nAPP_DB_PASSWORD=%s\n' "$pg" "$ap" > "$work/migrate.env"
cat > "$work/compose.env" <<EOF
API_IMAGE=$API_IMAGE
WEB_IMAGE=$WEB_IMAGE
CIVICSIGNAL_ENV_FILE=$work/app.env
CIVICSIGNAL_MIGRATE_ENV_FILE=$work/migrate.env
POSTGRES_PASSWORD_FILE=$work/postgres_password
REDIS_PASSWORD_FILE=$work/redis_password
PUBLIC_DOMAIN=localhost
ACME_EMAIL=ops@civicsignal.invalid
EOF

echo "[1/7] data services and migrations"
"${C[@]}" up -d --wait db redis >/dev/null 2>&1 || fail "db/redis not healthy"
"${C[@]}" --profile migrate run --rm migrate | tail -1 || fail "migrate job failed"

echo "[2/7] application services (waiting for health checks)"
"${C[@]}" up -d --wait --wait-timeout 180 api worker web edge >/dev/null 2>&1 || fail "services not healthy"
cid() { "${C[@]}" ps -aq "$1"; }

echo "[3/7] container hardening"
for s in api worker web; do
  id=$(cid "$s")
  [ "$(docker exec "$id" id -u)" != 0 ] || fail "$s runs as root"
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$id")" = true ] || fail "$s root filesystem is writable"
  [ "$(docker inspect -f '{{.HostConfig.CapDrop}}' "$id")" = "[ALL]" ] || fail "$s keeps capabilities"
  docker exec "$id" sh -c 'touch /app/.w 2>/dev/null' && fail "$s can write to /app"
done
for s in api worker web db redis; do
  [ -z "$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$(cid "$s")")" ] || fail "$s publishes a port"
done
echo "  api, worker, web: non-root, read-only, no capabilities; only the edge publishes ports"

echo "[4/7] smoke test over HTTPS"
for _ in $(seq 1 20); do docker cp "$(cid edge):/data/caddy/pki/authorities/local/root.crt" "$work/ca.crt" >/dev/null 2>&1 && break; sleep 1; done
export NODE_EXTRA_CA_CERTS="$work/ca.crt" NO_PROXY="localhost,127.0.0.1" no_proxy="localhost,127.0.0.1"
SMOKE_EMAIL=smoke@civicsignal.invalid SMOKE_PASSWORD="$smoke_pw" node -e '
  const B="https://localhost", h={"content-type":"application/json",origin:B};
  (async()=>{
    let r=await fetch(B+"/api/v1/auth/register",{method:"POST",headers:h,body:JSON.stringify({email:process.env.SMOKE_EMAIL,password:process.env.SMOKE_PASSWORD,displayName:"Smoke test"})});
    if(r.status!==201) throw new Error("register "+r.status);
    const c=(r.headers.getSetCookie().find(x=>/cs_session=/.test(x))||"").split(";")[0];
    r=await fetch(B+"/api/v1/organizations",{method:"POST",headers:{...h,cookie:c},body:JSON.stringify({name:"Smoke test (internal)"})});
    if(r.status!==201) throw new Error("organization "+r.status);
  })().catch(e=>{console.error(e.message);process.exit(1)})' || fail "could not create the smoke-test account"
BASE_URL=https://localhost SMOKE_EMAIL=smoke@civicsignal.invalid SMOKE_PASSWORD="$smoke_pw" node "$repo/scripts/smoke.mjs" || fail "smoke test"
m=$(docker exec "$(cid api)" node -e "fetch('http://localhost:4000/metrics').then(r=>console.log(r.status)).catch(e=>console.log(e.message))" 2>&1 || true)
[ "$m" = 401 ] || fail "/metrics without a token answered: $m (expected 401)"
# The documented first-start step (DEPLOYMENT.md): grant platform-admin rights through the migrate job's owner credentials.
out=$("${C[@]}" --profile migrate run --rm migrate node apps/api/dist/database/promote-platform-admin-cli.js smoke@civicsignal.invalid 2>&1) \
  || fail "platform-admin bootstrap command failed: $(tail -3 <<<"$out")"

echo "[5/7] encrypted backup and restore drill (scratch database on the same server)"
export GNUPGHOME="$work/gnupg"; mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
gpg --batch --quiet --passphrase '' --quick-gen-key "stack-test <stack-test@civicsignal.invalid>" default default 1d
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$(cid db)" | awk '{print $1}')
MIGRATION_DATABASE_URL="postgres://civicsignal_owner:$pg@$ip:5432/civicsignal" BACKUP_GPG_RECIPIENT=stack-test@civicsignal.invalid \
  bash "$repo/scripts/backup.sh" "$work/stack.dump" >/dev/null || fail "backup"
drill=$(ADMIN_DATABASE_URL="postgres://civicsignal_owner:$pg@$ip:5432/postgres" bash "$repo/scripts/verify-restore.sh" "$work/stack.dump.gpg" 2>&1) \
  || fail "restore drill: $(tail -5 <<<"$drill" | tr '\n' ' ')"
tail -1 <<<"$drill"
"${C[@]}" restart api >/dev/null 2>&1 && "${C[@]}" up -d --wait api >/dev/null 2>&1 || fail "api not healthy after the restore drill (drill must not touch the live database or its role)"
echo "  live API healthy after the drill (fresh connections)"

echo "[6/7] graceful shutdown and log hygiene"
"${C[@]}" stop -t 120 worker >/dev/null 2>&1
code=$(docker inspect -f "{{.State.ExitCode}}" "$(cid worker)"); [ "$code" = 0 ] || fail "worker did not exit cleanly on SIGTERM (exit code $code)"
"${C[@]}" logs --no-color worker | grep -q '"event":"ingestion.worker_stopping"' || fail "worker did not log its shutdown"
logs="$("${C[@]}" logs --no-color 2>&1)"
for v in "$pg" "$rp" "$ap" "$metrics" "$smoke_pw"; do grep -qF -- "$v" <<<"$logs" && fail "a generated secret appears in container logs"; done
echo "  worker drained and exited 0; no generated secret in any log"

echo "[7/7] stack test passed"
