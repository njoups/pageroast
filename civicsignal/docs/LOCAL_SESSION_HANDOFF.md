# Handoff: run CivicSignal on this laptop (for a local Claude Code session)

> **Untuk pemilik laptop:** buka Terminal di Mac, jalankan `claude` (instal dulu: `curl -fsSL https://claude.ai/install.sh | bash`),
> lalu paste:
> *"Baca dan kerjakan civicsignal/docs/LOCAL_SESSION_HANDOFF.md dari repo njoups/pageroast branch claude/youthful-darwin-rk5mhl.
> Clone dulu ke ~/Desktop kalau belum ada."*
> Claude akan menjalankan semua langkah di bawah dan melapor dalam bahasa Indonesia.

---

## Context (for the Claude session reading this)
- **Who you are working for:**
  - The user is a digital marketer, not a developer. Reply in **Indonesian**, briefly, with one next action at a time.
  - They want to **see the CivicSignal web app running on this Mac** at `http://localhost:3000`.
- **What happened so far:**
  - Docker was not installed. The user says they have installed Docker Desktop since.
  - The browser showed "This site can't be reached", meaning nothing is listening yet.
- **What CivicSignal is:**
  - A media-monitoring app: a NestJS API, a worker and a Next.js web app, plus Postgres, Redis, a Caddy edge proxy and Mailpit (a local email inbox), all run through Docker Compose.
  - The one-command setup is `civicsignal/scripts/local-up.sh`. The human guide is `civicsignal/docs/LOCAL_SETUP.md`.

## Rules
- **Never commit, push, or open pull requests.** This is a local run only.
- **Never print, paste or upload the contents of `civicsignal/.env`.** It holds generated passwords. Never commit it either (it is gitignored).
- Do not change application code to "make it work". If something in the repository looks broken, stop and report the exact error to the user. The fix belongs in the repository, through its owner.
- Do not run `docker compose down -v`, delete Docker volumes or prune images unless the user agrees; it erases their local data.
- Ask before installing anything other than what is listed here (Docker Desktop and the Xcode Command Line Tools for `git`).

## Steps

### 1. Check the machine
```bash
sw_vers; uname -m                       # macOS version; arm64 = Apple Silicon, x86_64 = Intel
docker --version || echo "NO DOCKER CLI"
docker info --format '{{.ServerVersion}}' 2>&1 | head -1   # a version number = engine running
docker compose version
git --version || echo "NO GIT"
```
- **No Docker CLI:**
  - Docker Desktop is not installed, or its CLI is not on PATH. Check `/Applications/Docker.app`.
  - If the app exists, run `open -a Docker` and wait for the engine. Then check `ls -l /usr/local/bin/docker`, or add `~/.docker/bin` to PATH: `export PATH="$HOME/.docker/bin:$PATH"`.
  - If the app does not exist, ask the user to install Docker Desktop from https://www.docker.com/products/docker-desktop/ (Apple Silicon or Intel build to match `uname -m`).
  - With the user's consent, Homebrew can install it instead: `brew install --cask docker`, then `open -a Docker`.
- **CLI present but `docker info` fails:**
  - Run `open -a Docker`.
  - Poll until `docker info` succeeds: `until docker info >/dev/null 2>&1; do sleep 3; done`, with a time limit of about 3 minutes.
  - The first start may show a macOS permission dialog. Tell the user to approve it.
- **No git:** `xcode-select --install` opens an installer dialog. Ask the user to click Install and wait for it to finish.

### 2. Docker resources
Check memory: `docker info --format '{{.MemTotal}}'` should be at least about 4 GB (4000000000 bytes).
If it is lower, ask the user to raise it in Docker Desktop → Settings → Resources → Memory (4–8 GB), then Apply & restart.

### 3. Get the code
```bash
cd ~/Desktop
[ -d pageroast ] || git clone -b claude/youthful-darwin-rk5mhl https://github.com/njoups/pageroast.git
cd pageroast && git fetch origin claude/youthful-darwin-rk5mhl && git checkout claude/youthful-darwin-rk5mhl && git pull --ff-only
cd civicsignal
```
If the clone asks for credentials, the repository has been made private. Ask the user to sign in, for example with `gh auth login`, or with GitHub Desktop.

### 4. Start it
```bash
bash scripts/local-up.sh
```
- **Expected:**
  - The script creates `.env` with random secrets and picks free ports.
  - It builds the `civicsignal-api:local` and `civicsignal-web:local` images. The first time this takes about 5–10 minutes, because it downloads npm and Debian packages.
  - It starts every service and waits for health checks.
  - It ends with **"CivicSignal is running"** and the addresses.
- **If the script fails, diagnose before retrying.** Read these (they are safe to show; never show `.env`):
```bash
docker compose ps -a
docker compose logs --tail 80 migrate api worker web edge
```

| Symptom | Likely cause | Action |
|---|---|---|
| `npm ci` / `apt-get` errors during build | Network, VPN or corporate proxy | Ask the user to disconnect the VPN or check their connection; rerun |
| `no matching manifest for linux/arm64` | Image without an arm64 build | Report the image name to the user (all pinned images were checked to include arm64 on 2026-10-21) |
| `migrate` exited non-zero | Database not ready or a migration error | Show the last migrate log lines to the user; do not edit migrations |
| `api` unhealthy, log says `Missing required environment variable` or `must ...` | `.env` problem | Compare the variable names in `.env.example` with `.env` (names only, not values) |
| Container exit code 137 | Out of memory | Raise Docker memory (step 2) |
| `port is already allocated` | Another app uses the port | Edit `WEB_HOST_PORT`, `DB_HOST_PORT` or `MAIL_HOST_PORT` in `.env` to a free port, and keep `APP_ORIGINS`/`APP_BASE_URL` equal to `http://localhost:<WEB_HOST_PORT>` |
| `.env` exists from a failed earlier attempt and values look wrong | Partial run | Ask the user before deleting `.env` and running `docker compose down -v`; then rerun the script |

### 5. Verify it really works
```bash
WEB=$(grep '^WEB_HOST_PORT=' .env | cut -d= -f2); WEB=${WEB:-3000}
curl -s "http://localhost:$WEB/healthz"; echo
curl -s "http://localhost:$WEB/readyz"; echo        # must print {"status":"ok"}
BASE_URL="http://localhost:$WEB" SMOKE_EXPECT_HTTPS=false node scripts/smoke.mjs 2>/dev/null || echo "(node not installed on the Mac: skip the smoke test, the curl checks above are enough)"
open "http://localhost:$WEB"
```
Then tell the user, in Indonesian:
- the app address;
- the email inbox at `http://localhost:<MAIL_HOST_PORT>`;
- that they should use Chrome, Edge or Firefox (Safari may refuse the login cookie on `http://localhost`);
- that next they register, create an organization and follow `docs/LOCAL_SETUP.md` section 4.

### 6. If the browser still says "This site can't be reached"
- Run `docker compose ps`. `edge` must be **Up** and show `127.0.0.1:<port>->8080/tcp`.
- The URL must use that same port, on this Mac (not a phone).
- Run `curl -I http://localhost:<port>/login` from Terminal:
  - If curl works but the browser does not, it is a browser proxy or VPN extension. Try a private window or another browser.
  - If curl fails too, check `docker compose logs --tail 50 edge web`.

## Handy commands for the user
| Task | Command (run in `~/Desktop/pageroast/civicsignal`) |
|---|---|
| Stop (keeps data) | `docker compose stop` |
| Start again | `bash scripts/local-up.sh --no-build` |
| Update after new commits | `git pull` then `bash scripts/local-up.sh` |
| Become platform admin | `docker compose run --rm migrate node apps/api/dist/database/promote-platform-admin-cli.js <email>` |
