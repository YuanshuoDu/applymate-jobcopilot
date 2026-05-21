# ApplyMate AI

> **AI-powered job application co-pilot for the European market.**  
> Automate the tedious parts of job hunting — from smart job discovery to tailored CVs and cover letters — while keeping humans in control of every decision that matters.

[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.0-38bdf8?logo=tailwindcss)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is ApplyMate AI?

ApplyMate AI is a **Chrome Extension + Web Dashboard** combo that acts as your personal job application assistant. It discovers relevant jobs, tailors your CV and cover letter for each role, and — with your approval — auto-fills application forms. Think of it as a shopping cart for job applications: browse JDs → one-click save → AI optimises → you review → auto-submit.

### Key Principles
- **Human-in-the-loop**: AI handles preparation; you make every application decision.
- **Europe-first**: GDPR-compliant, deep ATS support (Workday EMEA, Personio, SmartRecruiters), multi-language cover letters (EN/DE/FR/NL/ES).
- **Model-agnostic**: Switch between Claude, GPT-4o, or Ollama via the built-in ModelRouter without changing any code.

---

## Features

### Agent Pipeline
- **OrchestratorAgent** — Claude Code-style harness: Plan → Dispatch → Evaluate → Fix → Retry
- **Scout Agent** — Discovers jobs from LinkedIn, Adzuna, Indeed IE, IrishJobs RSS, and company ATS portals
- **Analyst Agent** — Scores and ranks jobs against your profile; configurable AI throttle
- **Writer Agent** — Generates tailored cover letters (0–10 quality scoring before sending)
- **Executor Agent** — Manages a manual-confirm apply queue; you approve each application
- **Auditor Agent** — Monitors Gmail for interview/offer/rejection emails; drafts follow-up emails for rejections
- **Custom Agents** — Add your own agent roles via the UI; they run as pipeline stages

### Resume & Cover Letter System
- Upload and parse existing resumes (PDF/DOCX)
- Multi-direction resume library (Base / Adapted / ⭐ Final badges)
- AI tailoring with per-section model selection (Claude/GPT/Ollama)
- 3 cover letter PDF templates
- One-click Bundle ZIP download (CV + CL per job)
- Version history with restore

### Smart Job Search
- NLP city extraction from queries (`"software engineer Dublin"` → `location=Dublin`)
- Stale-filter detection with auto-apply on panel close
- Location relevance scoring (+6 for city match, -3 for global-remote mismatch)
- 60+ EU city mappings; Ireland has dedicated LinkedIn IE + Indeed IE + IrishJobs routing

### Chrome Extension
- One-click "Save to Basket" button injected on LinkedIn, Indeed, and company career pages
- Sidebar with Resume Preview / Templates / AI Match / PDF / three-way sync with dashboard
- iframe-compatible form auto-fill (Workday, Greenhouse, Lever, SmartRecruiters, Personio)
- Bidirectional login/logout sync with dashboard (JWT bridge)

### Dashboard
- Kanban job board with drag-and-drop
- AI Persona system (auto-classifies user profile, pre-fills application fields)
- Onboarding flow for new users
- i18n support (EN baseline + extensible)
- Real-time SSE event log from the Agent Pipeline

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Monorepo | Turborepo + pnpm Workspaces | 2.x / 10.x |
| Web Dashboard | Next.js App Router | ^15.2 |
| Chrome Extension | Vite + React (Content Script + Sidebar) | ^6.4 |
| UI Components | shadcn/ui + Radix UI | latest |
| Styling | Tailwind CSS | **^4.0** |
| ORM | Prisma | ^6.8 |
| Database | PostgreSQL (Neon / Supabase) | 16.x |
| Auth | NextAuth v5 | ^5.x |
| AI SDK | Vercel AI SDK | ^4.0 |
| AI Models | Claude (Anthropic), GPT-4o (OpenAI), Ollama | — |
| Rich Text | Tiptap | ^2.10 |
| PDF | @react-pdf/renderer | ^4.5 |
| Object Storage | Cloudflare R2 | — |
| Queue | BullMQ + Redis | ^5.0 |
| Monitoring | Sentry + PostHog | latest |
| Drag & Drop | @dnd-kit | — |
| Testing | Playwright (E2E) | — |

---

## Project Structure

```
jobcopilot/
├── apps/
│   ├── web/                  # Next.js Dashboard (port 3000)
│   │   ├── app/              # App Router pages & API routes
│   │   ├── components/       # UI components
│   │   ├── lib/
│   │   │   ├── agent/        # OrchestratorAgent + pipeline stages
│   │   │   │   ├── orchestrator.ts   # Main harness (Plan/Dispatch/Evaluate/Fix)
│   │   │   │   ├── pipeline.ts       # Stage runner + retry loop
│   │   │   │   └── stages/           # discover / analyze / write / gate / execute / audit / custom
│   │   │   ├── ai/           # ModelRouter + prompt templates
│   │   │   └── pdf/          # Resume & cover letter PDF generation
│   │   └── prisma/           # Schema + migrations
│   └── extension/            # Chrome Extension (Vite)
│       ├── src/
│       │   ├── content/      # Content scripts (job capture, form fill)
│       │   ├── sidebar/      # React sidebar app
│       │   └── background/   # Service worker (JWT bridge, message routing)
│       └── vite.config.ts
├── packages/
│   ├── shared/               # Types, Zod schemas, utilities
│   ├── ui/                   # Shared React components
│   ├── ai-prompts/           # Versioned prompt templates
│   └── eslint-config/
├── e2e/                      # Playwright end-to-end tests
├── turbo.json
└── pnpm-workspace.yaml
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9
- Docker (for local PostgreSQL + Redis)
- A Neon or Supabase PostgreSQL instance (or local Docker)

### 1. Clone & install

```bash
git clone https://github.com/your-org/applymate-ai.git
cd applymate-ai/jobcopilot
pnpm install
```

### 2. Configure environment variables

```bash
cp apps/web/.env.example apps/web/.env.local
```

Edit `.env.local` — see [Environment Variables](#environment-variables) below.

### 3. Start backing services

```bash
docker-compose up -d   # PostgreSQL on 5432, Redis on 6379
```

### 4. Run database migrations

```bash
pnpm --filter web db:push   # prisma db push
```

### 5. Start the development server

```bash
pnpm dev   # Starts web (3000) + extension (HMR) in parallel via Turborepo
```

### 6. Load the extension

1. Build the extension: `pnpm --filter extension build:dev`
2. Open Chrome → `chrome://extensions` → Enable Developer mode
3. Click "Load unpacked" → select `apps/extension/dist`

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/applymate

# Auth
NEXTAUTH_SECRET=your-secret-here
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# AI Models
ANTHROPIC_API_KEY=           # Claude (Scout / Analyst / Writer / Auditor)
OPENAI_API_KEY=              # GPT-4o fallback
OLLAMA_BASE_URL=             # http://localhost:11434 (optional local model)

# Job Search APIs
ADZUNA_APP_ID=
ADZUNA_APP_KEY=

# Gmail (Auditor Agent)
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=

# Storage
CLOUDFLARE_R2_ACCOUNT_ID=
CLOUDFLARE_R2_ACCESS_KEY_ID=
CLOUDFLARE_R2_SECRET_ACCESS_KEY=
CLOUDFLARE_R2_BUCKET=

# Extension security
EXTENSION_HMAC_SECRET=

# Redis
REDIS_URL=redis://localhost:6379

# Monitoring (optional)
NEXT_PUBLIC_SENTRY_DSN=
NEXT_PUBLIC_POSTHOG_KEY=
```

---

## Deployment

The production build is deployed on **Vercel** at [applymate.dev](https://applymate.dev).

```bash
pnpm build        # Build all apps
pnpm typecheck    # Type-check all packages
```

For the Chrome Extension, submit the output of `pnpm --filter extension build` to the Chrome Web Store.

---

## Roadmap

- [ ] LinkedIn / Indeed direct API key configuration page
- [ ] Agent run history browser (per-day pipeline results)
- [ ] Resume tailoring wizard (AI Adapt — per-job CV customisation)
- [ ] Extension + Executor bidirectional apply (auto form-fill triggered by pipeline)
- [ ] Screenshot OCR for non-parseable JDs
- [ ] AI Auto-Pilot `full` mode (end-to-end autonomous application)

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit using [Conventional Commits](https://www.conventionalcommits.org): `feat: add X`, `fix: resolve Y`
4. Open a pull request

Please run `pnpm lint && pnpm typecheck` before submitting.

---

## License

MIT © 2026 ApplyMate AI
