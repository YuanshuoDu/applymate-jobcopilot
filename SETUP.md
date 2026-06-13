# ApplyMate AI — Backend Setup Guide

## 1. Install dependencies

```bash
cd apps/web
pnpm install
```

## 2. Configure environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection String (URI) |
| `AUTH_SECRET` | Run: `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID / SECRET` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| `AUTH_GITHUB_ID / SECRET` | [GitHub Developer Settings](https://github.com/settings/developers) |

> **Quick local start (no OAuth needed):** Keep Google/GitHub empty. Use the Credentials provider with `demo@applymate.ai` / `demo1234` after seeding.

## 3. Set up the database

### Option A — Supabase (recommended, free tier)
1. Create a project at [supabase.com](https://supabase.com)
2. Copy the **URI** connection string (Settings → Database)
3. Paste into `DATABASE_URL` in `.env.local`

### Option B — Local PostgreSQL
```bash
# macOS
brew install postgresql@16 && brew services start postgresql@16
createdb applymate
```
Use `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/applymate"`

## 4. Run migrations + seed

```bash
# Generate Prisma client
pnpm prisma generate

# Create all tables
pnpm prisma migrate dev --name init

# Seed with demo data (10 jobs, activities, resume, agent config)
pnpm prisma db seed
```

Demo account created by seed:
- **Email:** demo@applymate.ai
- **Password:** demo1234

## 5. Start the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) 🚀

---

## Troubleshooting

### Recover from a stale `.next` build cache

If the dev server fails with an `ENOENT` error for `jose.js` under `apps/web/.next`, clear the cached Next.js build output and start again:

```bash
rm -rf apps/web/.next && pnpm dev
```

You can also run the web app's clean-start helper:

```bash
pnpm --filter web dev:clean
```

---

## API Reference

All routes require authentication (session cookie or JWT) except `/api/auth/*`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/me` | Current user profile |
| PATCH | `/api/me` | Update name / image |
| POST | `/api/auth/register` | Create account (email + password) |
| GET | `/api/jobs` | List jobs (`?status=&q=&page=&pageSize=`) |
| POST | `/api/jobs` | Create job |
| GET | `/api/jobs/:id` | Get job |
| PATCH | `/api/jobs/:id` | Update job (status, notes, etc.) |
| DELETE | `/api/jobs/:id` | Delete job |
| GET | `/api/dashboard` | Dashboard stats + pipeline + activity |
| GET | `/api/activity` | Activity feed (`?limit=&jobId=`) |
| POST | `/api/activity` | Create activity entry |
| GET | `/api/resume` | List resumes |
| POST | `/api/resume` | Create resume |
| GET | `/api/resume/:id` | Get resume with content |
| PATCH | `/api/resume/:id` | Update resume |
| DELETE | `/api/resume/:id` | Delete resume |
| GET | `/api/agent` | Get agent config |
| PATCH | `/api/agent` | Update agent config |

## Prisma Studio (visual DB browser)

```bash
pnpm prisma studio
```
Opens at [http://localhost:5555](http://localhost:5555)
