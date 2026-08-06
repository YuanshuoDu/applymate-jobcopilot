# ApplyMate AI

> **AI-powered job application co-pilot for the European market.**  
> Discover relevant roles, tailor CVs and cover letters, and complete supported ATS workflows while keeping humans in control of every decision that matters.

Production: [applymate.site](https://applymate.site) · Preview: [preview.applymate.site](https://preview.applymate.site)

[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.0-38bdf8?logo=tailwindcss)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is ApplyMate AI?

ApplyMate AI is a **Chrome Extension + Web Dashboard + Worker** platform that acts as your personal job application assistant. It discovers relevant jobs, tailors your CV and cover letter for each role, and supports both reviewable form filling and autonomous ATS application workflows. Think of it as a shopping cart for job applications: browse JDs → one-click save → AI optimises → you review → apply.

Repository: [github.com/YuanshuoDu/applymate-jobcopilot](https://github.com/YuanshuoDu/applymate-jobcopilot)

### Key Principles
- **User-controlled automation**: AI prepares applications and can automate supported ATS workflows; you choose what enters the application queue.
- **Europe-first**: GDPR-compliant, deep ATS support (Workday EMEA, Personio, SmartRecruiters), multi-language cover letters (EN/DE/FR/NL/ES).
- **Model-agnostic**: ModelRouter supports MiniMax, Anthropic, OpenAI, DeepSeek, Qwen, Z.ai, Kimi, and compatible custom endpoints.
- **Privacy-first administration**: Internal roles are isolated from candidate content. Administrators, including `super_admin` and break-glass operators, cannot read API keys, password hashes, OAuth refresh tokens, full resumes, or email bodies.

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
- AI tailoring with per-section model selection through ModelRouter
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

### Secure Admin Console
- Role- and permission-based access for support, operations, billing, security, platform, and super-admin teams
- Masked user metadata, safe application diagnostics, ATS source health, queue controls, AI budgets, feature flags, and audit search
- Contact us support workspace with assignments, SLA status, customer-visible replies, internal notes, and safe context only
- Broadcast drafts, anonymous audience previews, approval separation, and idempotent delivery through the existing in-app `Notification` records
- Append-only audit events, CSRF protection, idempotency keys, optimistic versioning, and signed Worker commands for every write

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
| AI Models | MiniMax, Anthropic, OpenAI, DeepSeek, Qwen, Z.ai, Kimi, custom OpenAI-compatible endpoints | ModelRouter |
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
applymate-jobcopilot/
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
│   ├── extension/            # Chrome Extension (Vite)
│   │   ├── src/
│   │   │   ├── content/      # Content scripts (job capture, form fill)
│   │   │   ├── sidebar/      # React sidebar app
│   │   │   └── background/   # Service worker (JWT bridge, message routing)
│   │   └── vite.config.ts
│   └── worker/               # BullMQ worker + ATS auto-apply flows
│       └── src/
│           ├── flows/        # Workday, Greenhouse, Lever, SmartRecruiters, Personio
│           └── integration/  # Pipeline and harness tests
├── packages/
│   ├── shared/               # Types, Zod schemas, utilities
│   ├── ui/                   # Shared React components
│   ├── ai-prompts/           # Versioned prompt templates
│   └── eslint-config/
├── docs/                     # API reference, runbooks, architecture docs
├── e2e/                      # Playwright end-to-end tests
├── turbo.json
└── pnpm-workspace.yaml
```

---

## Documentation

- [API Reference](docs/api-reference.md) — route-by-route request, response, auth, and curl examples.
- [Auto-Apply Runbook](docs/runbook.md) — production incident response for queues, workers, CAPTCHA, and rate limits.
- [Scraping & Auto-Apply Design](docs/scraping-autoapply-design.md) — architecture and flow design notes.
- [Scraping & Auto-Apply Developer Guide](docs/scraping-autoapply-dev-guide.md) — implementation guidance for worker and ATS flows.
- [Admin Console RBAC Design](docs/admin-console-rbac-design.md) — permissions, data isolation, support, broadcasts, and operational controls.
- [Admin Console Implementation Plan](docs/admin-console-implementation-plan.md) — delivered controls and deployment release gates.
- [GitHub Collaboration](docs/github-collaboration.md) — issue, PR, review, and CI workflow.
- [Docs Index](docs/README.md) — quick map of maintained documentation.

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9
- Docker (for local PostgreSQL + Redis)
- A Neon or Supabase PostgreSQL instance (or local Docker)

### 1. Clone & install

```bash
git clone https://github.com/YuanshuoDu/applymate-jobcopilot.git
cd applymate-jobcopilot
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
pnpm --filter @jobcopilot/web db:push   # prisma db push
```

### 5. Start the development server

```bash
pnpm dev   # Starts web (3000) + extension (HMR) in parallel via Turborepo
```

### 6. Load the extension

1. Build the extension: `pnpm --filter @jobcopilot/extension build`
2. Open Chrome → `chrome://extensions` → Enable Developer mode
3. Click "Load unpacked" → select `apps/extension/dist`

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/applymate

# Auth (Auth.js / NextAuth v5)
AUTH_SECRET=your-secret-here
NEXTAUTH_URL=http://localhost:3000
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=

# AI Models
MINIMAX_API_KEY=             # Platform default model
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
QWEN_API_KEY=
ZHIPU_API_KEY=
KIMI_API_KEY=

# Job Search APIs
ADZUNA_APP_ID=
ADZUNA_APP_KEY=

# Worker and queue control
REDIS_URL=redis://localhost:6379
AGENT_WORKER_SECRET=
WORKER_CONTROL_URL=
WORKER_CONTROL_SECRET=

# Storage
CLOUDFLARE_R2_ACCOUNT_ID=
CLOUDFLARE_R2_ACCESS_KEY_ID=
CLOUDFLARE_R2_SECRET_ACCESS_KEY=
CLOUDFLARE_R2_BUCKET=

# Extension security
EXTENSION_HMAC_SECRET=

# Monitoring (optional)
NEXT_PUBLIC_SENTRY_DSN=
NEXT_PUBLIC_POSTHOG_KEY=
```

The complete, environment-specific list is maintained in [`apps/web/.env.example`](apps/web/.env.example). Never commit `.env.local` or provider credentials.

---

## Deployment

The web dashboard is deployed on **Vercel**. Production is [applymate.site](https://applymate.site); the branch-linked Preview environment is [preview.applymate.site](https://preview.applymate.site).

- A push or merge to `master` creates a Production deployment.
- The `sync-staging` GitHub Actions workflow mirrors `master` to `staging` after each production-branch push.
- Vercel tracks `staging`, so `preview.applymate.site` automatically follows the newest Preview deployment without a manual alias command.

```bash
pnpm build        # Build all apps
pnpm typecheck    # Type-check all packages
```

For the Chrome Extension, submit the output of `pnpm --filter @jobcopilot/extension build` to the Chrome Web Store.

The Worker runs separately from the Vercel web deployment and owns BullMQ queues, ATS apply flows, and the signed internal admin control endpoint. Bull Board is not exposed by the production console.

---

## Validation

Use these root-level commands before merging changes:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For worker or E2E-heavy changes, also run the targeted commands documented in the relevant PR or issue.

## Security and privacy

The admin console is a separate internal surface under `/admin` and `/api/admin/v1`. Authorization is enforced on the server with explicit permissions; `User.plan` is never an admin role. Admin DTOs use allow-listed metadata only, and audit snapshots exclude secrets and candidate content. Contact us staff may read only messages intentionally submitted to support, while platform broadcasts create standard in-app notifications that remain visible only to the addressed user.

---

## Roadmap

- [ ] LinkedIn / Indeed direct API key configuration page
- [x] Agent run history browser (per-day pipeline results)
- [x] Resume tailoring wizard (AI Adapt — per-job CV customisation)
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
