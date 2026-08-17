# ============================================================
# ApplyMate AI — One-click installation configuration script
# Right click on this file → "use PowerShell run"
# ============================================================
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "ApplyMate AI Setup"

function Write-Step($msg) {
    Write-Host "`n▶ $msg" -ForegroundColor Cyan
}
function Write-OK($msg) {
    Write-Host "  ✓ $msg" -ForegroundColor Green
}
function Write-Warn($msg) {
    Write-Host "  ⚠ $msg" -ForegroundColor Yellow
}
function Write-Fail($msg) {
    Write-Host "`n✗ mistake: $msg" -ForegroundColor Red
    Read-Host "`naccording to Enter quit"
    exit 1
}

Clear-Host
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║     ApplyMate AI — Automatic installation configuration          ║" -ForegroundColor Blue
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Blue

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$WEB  = Join-Path $ROOT "apps\web"
Set-Location $WEB

# ── 1. examine Node.js ──────────────────────────────────────────
Write-Step "examine Node.js..."
try {
    $nodeVer = node --version 2>&1
    Write-OK "Node.js $nodeVer"
} catch {
    Write-Fail "not found Node.js, Please install first https://nodejs.org (LTS version)"
}

# ── 2. examine / Install pnpm ───────────────────────────────────────
Write-Step "examine pnpm..."
$hasPnpm = $null
try { $hasPnpm = pnpm --version 2>&1 } catch {}
if (-not $hasPnpm) {
    Write-Warn "pnpm Not installed, Currently using npm Install..."
    npm install -g pnpm | Out-Null
    $hasPnpm = pnpm --version 2>&1
}
Write-OK "pnpm $hasPnpm"

# ── 3. Install dependency packages ─────────────────────────────────────────────
Write-Step "Install dependency packages (pnpm install)..."
pnpm install
if ($LASTEXITCODE -ne 0) { Write-Fail "pnpm install fail" }
Write-OK "Dependency installation completed"

# ── 4. Configuration .env.local ────────────────────────────────────────
Write-Step "Configure environment variables..."
$envFile = Join-Path $WEB ".env.local"

if (Test-Path $envFile) {
    Write-OK ".env.local Already exists, jump over"
} else {
    Write-Host ""
    Write-Host "  need one PostgreSQL Database connection." -ForegroundColor White
    Write-Host "  Detected that this machine is installed PostgreSQL(pgAdmin 4)." -ForegroundColor White
    Write-Host ""
    Write-Host "  Please enter PostgreSQL password(By default, leave it blank and enter directly to try. 'postgres'): " -ForegroundColor Yellow
    $pgPass = Read-Host "  password"
    if ([string]::IsNullOrWhiteSpace($pgPass)) { $pgPass = "postgres" }

    Write-Host "  Database name(default applymate, Just press Enter): " -ForegroundColor Yellow
    $pgDb = Read-Host "  Database name"
    if ([string]::IsNullOrWhiteSpace($pgDb)) { $pgDb = "applymate" }

    $dbUrl = "postgresql://postgres:${pgPass}@localhost:5432/${pgDb}"

    # generate AUTH_SECRET
    $authSecret = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

    $envContent = @"
# ApplyMate AI — Local development environment variables
DATABASE_URL="$dbUrl"
AUTH_SECRET="$authSecret"
NEXTAUTH_URL="http://localhost:3000"
AUTH_GOOGLE_ID=""
AUTH_GOOGLE_SECRET=""
AUTH_GITHUB_ID=""
AUTH_GITHUB_SECRET=""
OPENAI_API_KEY=""
ANTHROPIC_API_KEY=""
"@
    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
    Write-OK ".env.local Generated(DATABASE_URL=$dbUrl)"
}

# ── 5. create PostgreSQL database ─────────────────────────────────
Write-Step "create PostgreSQL database..."
# Read database name
$envContent = Get-Content $envFile -Raw
if ($envContent -match 'DATABASE_URL="postgresql://[^:]+:([^@]*)@[^/]+/([^"\s]+)"') {
    $pgPass2 = $Matches[1]
    $pgDb2   = $Matches[2]
} else {
    $pgDb2 = "applymate"
    $pgPass2 = "postgres"
}

# Try using psql Create database
$psqlPaths = @(
    "C:\Program Files\PostgreSQL\17\bin\psql.exe",
    "C:\Program Files\PostgreSQL\16\bin\psql.exe",
    "C:\Program Files\PostgreSQL\15\bin\psql.exe",
    "C:\Program Files\PostgreSQL\14\bin\psql.exe",
    (Get-Command psql -ErrorAction SilentlyContinue)?.Source
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($psqlPaths) {
    $env:PGPASSWORD = $pgPass2
    & $psqlPaths -U postgres -c "CREATE DATABASE $pgDb2;" 2>&1 | Out-Null
    Write-OK "database '$pgDb2' Ready"
} else {
    Write-Warn "not found psql, Skip automatic database creation.If the database does not exist, please manually pgAdmin create '$pgDb2'"
}

# ── 6. Prisma Generate client ──────────────────────────────────────
Write-Step "generate Prisma client..."
pnpm prisma generate
if ($LASTEXITCODE -ne 0) { Write-Fail "prisma generate fail" }
Write-OK "Prisma Client generation completed"

# ── 7. Database migration ─────────────────────────────────────────────
Write-Step "Perform database migration (prisma migrate dev)..."
$env:DATABASE_URL = ($envContent | Select-String 'DATABASE_URL="([^"]+)"').Matches[0].Groups[1].Value
pnpm prisma migrate dev --name init
if ($LASTEXITCODE -ne 0) { Write-Fail "migrate fail, Check, please DATABASE_URL and PostgreSQL Whether to run" }
Write-OK "Data table creation completed"

# ── 8. Populate demo data ────────────────────────────────────────────
Write-Step "Populate demo data (prisma db seed)..."
pnpm prisma db seed
if ($LASTEXITCODE -ne 0) {
    Write-Warn "seed fail, Maybe the data already exists, continue..."
} else {
    Write-OK "Demo data filling completed"
    Write-Host "    account: demo@applymate.ai  password: demo1234" -ForegroundColor Magenta
}

# ── Finish ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         ✅ All installation and configuration completed!             ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Demo account: demo@applymate.ai" -ForegroundColor White
Write-Host "  demo password: demo1234" -ForegroundColor White
Write-Host ""

$launch = Read-Host "  Now start the development server?(y/n)"
if ($launch -eq 'y' -or $launch -eq 'Y' -or $launch -eq '') {
    Write-Host "`n  Starting... Browser opens http://localhost:3000" -ForegroundColor Cyan
    Start-Process "http://localhost:3000"
    pnpm dev
} else {
    Write-Host "`n  run later: cd apps\web && pnpm dev" -ForegroundColor Yellow
    Read-Host "according to Enter quit"
}
