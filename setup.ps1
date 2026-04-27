# ============================================================
# ApplyMate AI — 一键安装配置脚本
# 右键此文件 → "用 PowerShell 运行"
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
    Write-Host "`n✗ 错误: $msg" -ForegroundColor Red
    Read-Host "`n按 Enter 退出"
    exit 1
}

Clear-Host
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║     ApplyMate AI — 自动安装配置          ║" -ForegroundColor Blue
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Blue

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$WEB  = Join-Path $ROOT "apps\web"
Set-Location $WEB

# ── 1. 检查 Node.js ──────────────────────────────────────────
Write-Step "检查 Node.js..."
try {
    $nodeVer = node --version 2>&1
    Write-OK "Node.js $nodeVer"
} catch {
    Write-Fail "未找到 Node.js，请先安装 https://nodejs.org (LTS 版)"
}

# ── 2. 检查 / 安装 pnpm ───────────────────────────────────────
Write-Step "检查 pnpm..."
$hasPnpm = $null
try { $hasPnpm = pnpm --version 2>&1 } catch {}
if (-not $hasPnpm) {
    Write-Warn "pnpm 未安装，正在用 npm 安装..."
    npm install -g pnpm | Out-Null
    $hasPnpm = pnpm --version 2>&1
}
Write-OK "pnpm $hasPnpm"

# ── 3. 安装依赖包 ─────────────────────────────────────────────
Write-Step "安装依赖包 (pnpm install)..."
pnpm install
if ($LASTEXITCODE -ne 0) { Write-Fail "pnpm install 失败" }
Write-OK "依赖安装完成"

# ── 4. 配置 .env.local ────────────────────────────────────────
Write-Step "配置环境变量..."
$envFile = Join-Path $WEB ".env.local"

if (Test-Path $envFile) {
    Write-OK ".env.local 已存在，跳过"
} else {
    Write-Host ""
    Write-Host "  需要一个 PostgreSQL 数据库连接。" -ForegroundColor White
    Write-Host "  检测到本机已安装 PostgreSQL（pgAdmin 4）。" -ForegroundColor White
    Write-Host ""
    Write-Host "  请输入 PostgreSQL 密码（默认留空直接回车试 'postgres'）：" -ForegroundColor Yellow
    $pgPass = Read-Host "  密码"
    if ([string]::IsNullOrWhiteSpace($pgPass)) { $pgPass = "postgres" }

    Write-Host "  数据库名称（默认 applymate，直接回车）：" -ForegroundColor Yellow
    $pgDb = Read-Host "  数据库名"
    if ([string]::IsNullOrWhiteSpace($pgDb)) { $pgDb = "applymate" }

    $dbUrl = "postgresql://postgres:${pgPass}@localhost:5432/${pgDb}"

    # 生成 AUTH_SECRET
    $authSecret = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

    $envContent = @"
# ApplyMate AI — 本地开发环境变量
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
    Write-OK ".env.local 已生成（DATABASE_URL=$dbUrl）"
}

# ── 5. 创建 PostgreSQL 数据库 ─────────────────────────────────
Write-Step "创建 PostgreSQL 数据库..."
# 读取数据库名
$envContent = Get-Content $envFile -Raw
if ($envContent -match 'DATABASE_URL="postgresql://[^:]+:([^@]*)@[^/]+/([^"\s]+)"') {
    $pgPass2 = $Matches[1]
    $pgDb2   = $Matches[2]
} else {
    $pgDb2 = "applymate"
    $pgPass2 = "postgres"
}

# 尝试用 psql 创建数据库
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
    Write-OK "数据库 '$pgDb2' 已就绪"
} else {
    Write-Warn "未找到 psql，跳过自动建库。如数据库不存在请手动在 pgAdmin 创建 '$pgDb2'"
}

# ── 6. Prisma 生成客户端 ──────────────────────────────────────
Write-Step "生成 Prisma 客户端..."
pnpm prisma generate
if ($LASTEXITCODE -ne 0) { Write-Fail "prisma generate 失败" }
Write-OK "Prisma 客户端生成完成"

# ── 7. 数据库迁移 ─────────────────────────────────────────────
Write-Step "执行数据库迁移 (prisma migrate dev)..."
$env:DATABASE_URL = ($envContent | Select-String 'DATABASE_URL="([^"]+)"').Matches[0].Groups[1].Value
pnpm prisma migrate dev --name init
if ($LASTEXITCODE -ne 0) { Write-Fail "migrate 失败，请检查 DATABASE_URL 和 PostgreSQL 是否运行" }
Write-OK "数据表创建完成"

# ── 8. 填充演示数据 ────────────────────────────────────────────
Write-Step "填充演示数据 (prisma db seed)..."
pnpm prisma db seed
if ($LASTEXITCODE -ne 0) {
    Write-Warn "seed 失败，可能数据已存在，继续..."
} else {
    Write-OK "演示数据填充完成"
    Write-Host "    账号: demo@applymate.ai  密码: demo1234" -ForegroundColor Magenta
}

# ── 完成 ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         ✅ 安装配置全部完成！             ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  演示账号: demo@applymate.ai" -ForegroundColor White
Write-Host "  演示密码: demo1234" -ForegroundColor White
Write-Host ""

$launch = Read-Host "  现在启动开发服务器？(y/n)"
if ($launch -eq 'y' -or $launch -eq 'Y' -or $launch -eq '') {
    Write-Host "`n  启动中... 浏览器打开 http://localhost:3000" -ForegroundColor Cyan
    Start-Process "http://localhost:3000"
    pnpm dev
} else {
    Write-Host "`n  稍后运行: cd apps\web && pnpm dev" -ForegroundColor Yellow
    Read-Host "按 Enter 退出"
}
