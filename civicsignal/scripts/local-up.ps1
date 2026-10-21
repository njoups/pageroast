# Starts CivicSignal on a Windows laptop with Docker Desktop. Guide: docs/LOCAL_SETUP.md
#   powershell -ExecutionPolicy Bypass -File scripts\local-up.ps1            # first run builds the images (5-10 min)
#   powershell -ExecutionPolicy Bypass -File scripts\local-up.ps1 -NoBuild   # start with images already built
#   powershell -ExecutionPolicy Bypass -File scripts\local-up.ps1 -EnvOnly   # only create .env, start nothing
# Creates .env with random local-only secrets the first time (never commit it), starts every service, waits until all
# health checks pass and prints the addresses. Stop: docker compose stop. Remove everything incl. data: docker compose down -v
param([switch]$NoBuild, [switch]$EnvOnly)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Say($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Die($m) { Write-Host "`nError: $m" -ForegroundColor Red; exit 1 }

function RandomBytes([int]$n) {
  $b = New-Object byte[] $n
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
  return $b
}
function RandomHex([int]$chars) { -join ((RandomBytes ($chars / 2)) | ForEach-Object { $_.ToString('x2') }) }
function PortBusy([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { return $c.ConnectAsync('127.0.0.1', $p).Wait(300) } catch { return $false } finally { $c.Dispose() }
}
function FreePort([int]$p) { while (PortBusy $p) { $p++ }; return $p }

if (-not $EnvOnly) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/" }
  docker info *> $null; if ($LASTEXITCODE -ne 0) { Die "Docker is installed but not running. Start Docker Desktop, wait until it says 'running', then run this again." }
  docker compose version *> $null; if ($LASTEXITCODE -ne 0) { Die "Docker Compose v2 is missing. Update Docker Desktop." }
}

if (-not (Test-Path .env)) {
  Say 'Creating .env with random local secrets'
  $web = FreePort 3000; $db = FreePort 5432; $mail = FreePort 8025
  $values = [ordered]@{
    POSTGRES_PASSWORD = RandomHex 48; APP_DB_PASSWORD = RandomHex 48; REDIS_PASSWORD = RandomHex 48
    CREDENTIALS_KEY = [Convert]::ToBase64String((RandomBytes 32)); METRICS_TOKEN = RandomHex 64; APP_ENV = 'local'
    WEB_HOST_PORT = "$web"; DB_HOST_PORT = "$db"; MAIL_HOST_PORT = "$mail"
    APP_ORIGINS = "http://localhost:$web"; APP_BASE_URL = "http://localhost:$web"
  }
  $lines = [System.Collections.Generic.List[string]](Get-Content .env.example)
  foreach ($k in $values.Keys) {
    $i = $lines.FindIndex([Predicate[string]]{ param($l) $l.StartsWith("$k=") })
    if ($i -ge 0) { $lines[$i] = "$k=$($values[$k])" } else { $lines.Add("$k=$($values[$k])") }
  }
  # UTF-8 without a byte-order mark and with LF endings, as Docker Compose expects.
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
} else {
  Say 'Using the existing .env'
}
if ($EnvOnly) { Say '.env is ready.'; exit 0 }

$envMap = @{}; Get-Content .env | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object { $k, $v = $_ -split '=', 2; $envMap[$k] = $v }
$web = if ($envMap.WEB_HOST_PORT) { $envMap.WEB_HOST_PORT } else { '3000' }
$mail = if ($envMap.MAIL_HOST_PORT) { $envMap.MAIL_HOST_PORT } else { '8025' }

Say 'Starting CivicSignal (the first build downloads dependencies and can take 5-10 minutes)'
$composeArgs = @('compose', 'up', '-d', '--wait', '--wait-timeout', '300')
if (-not $NoBuild) { $composeArgs += '--build' }
& docker @composeArgs
if ($LASTEXITCODE -ne 0) { docker compose ps; Die 'Some services did not become healthy. Logs: docker compose logs --tail 50 api worker web' }

Say 'CivicSignal is running'
Write-Host @"
  App:         http://localhost:$web   (use Chrome, Edge or Firefox)
  Email inbox: http://localhost:$mail   (alerts, reports and password-reset emails arrive here)

  Next: open the app, click Register, create your organization, then follow docs/LOCAL_SETUP.md

  Make yourself a platform administrator (optional, for the /platform console):
    docker compose run --rm migrate node apps/api/dist/database/promote-platform-admin-cli.js you@example.com
  Stop:            docker compose stop        (data is kept)
  Start again:     powershell -ExecutionPolicy Bypass -File scripts\local-up.ps1 -NoBuild
  Delete all data: docker compose down -v
"@
