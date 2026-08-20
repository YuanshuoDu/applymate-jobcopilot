# ApplyMate AI

> **AI job-search copilot for the European market.**
>
> Discover relevant roles, understand your fit, tailor application materials, and track replies in one reviewable workflow.

[Production](https://applymate.site) · [Preview](https://preview.applymate.site)

ApplyMate brings job discovery, application preparation, supported ATS workflows,
and Gmail tracking into one place:

```text
discover → shortlist → tailor → review → approve → apply → track replies
```

The product is designed to keep the candidate in control. Final submission is
approval-gated per job. Login, MFA, CAPTCHA, and other candidate-only steps are
explicit handoffs rather than actions the system claims to have completed.

## What it does

- **Finds relevant jobs** from public search sources and company ATS portals, with European locations and role matching in mind.
- **Scores and shortlists roles** against a candidate profile so time is spent on the strongest opportunities.
- **Tailors resumes and cover letters** for individual jobs, with reusable versions and downloadable application packs.
- **Assists application workflows** through the web app, Chrome Extension, and supported ATS flow modules.
- **Tracks Gmail replies** for interview, offer, rejection, and follow-up signals after the candidate connects Google.
- **Runs queue-backed work** through a separate Worker for discovery, agent runs, and supported application tasks.

## Product surfaces

### Web app

The web app is the primary workspace for job search, resume management,
application preparation, approvals, Gmail tracking, and agent run history.

### Chrome Extension

The Extension helps capture jobs from LinkedIn, Indeed, and company career pages,
keeps saved jobs in sync with the web app, previews application material, and
assists with supported form fields.

### Worker

The Worker processes BullMQ jobs for discovery, agent runs, and application
tasks. It includes supported ATS flows for Workday, Greenhouse, Lever,
SmartRecruiters, and Personio, together with checkpoints, rate limits, form
patterns, and candidate handoffs.

## Features

### Job discovery

- Job search across public sources and company ATS portals
- European location matching, including dedicated Ireland routing
- Job scoring, keyword extraction, and shortlist management
- Stale-result detection and source-aware pacing

### Application preparation

- Resume upload and parsing for PDF/DOCX files
- Base and tailored resume versions with history and restore
- Per-job resume tailoring and cover-letter generation
- PDF templates and one-click application-pack downloads

### Gmail tracking

- OAuth connection with the Gmail read and send scopes required by the product
- Job-related inbox tracking, unread counts, and application-status recommendations
- User-confirmed follow-up drafts
- Credential encryption through Azure Key Vault in production

### Supported ATS workflows

- Workday
- Greenhouse
- Lever
- SmartRecruiters
- Personio

The system can pause for approval, missing form answers, login, MFA, CAPTCHA,
or another step that requires the candidate.

## Safety and privacy

- Application submission requires explicit approval for the specific job.
- Candidate-only authentication and challenge steps remain user handoffs.
- User data and connected accounts are scoped to the owning account.
- Production OAuth credentials are encrypted with an Azure Key Vault RSA key.
- Secrets and credential values are never intended for source control or public responses.

## Built with

| Area | Technology |
| --- | --- |
| Web app | Next.js App Router, React, TypeScript |
| Browser Extension | Vite, React, Chrome Manifest V3 |
| Data | PostgreSQL, Prisma |
| Background work | Node.js, BullMQ, Redis |
| Authentication | Auth.js / NextAuth |
| AI | ModelRouter with provider and OpenAI-compatible adapters |
| Deployment | Vercel for the web app, separate deployment for the Worker |
| Production credential protection | Azure Key Vault |

## Repository layout

```text
applymate-jobcopilot/
├── apps/
│   ├── web/          # Next.js web app and API routes
│   ├── extension/    # Chrome Extension
│   └── worker/       # Queue workers and ATS flows
├── packages/
│   ├── shared/       # Shared types and utilities
│   ├── ui/           # Shared UI components
│   └── ai-prompts/   # Versioned prompt templates
├── docs/             # Architecture, API, runbooks, and contributor docs
└── e2e/              # Playwright end-to-end tests
```

## Documentation

- [API reference](docs/api-reference.md)
- [Auto-apply runbook](docs/runbook.md)
- [Scraping and auto-apply design](docs/scraping-autoapply-design.md)
- [Scraping and auto-apply developer guide](docs/scraping-autoapply-dev-guide.md)
- [Documentation index](docs/README.md)

## Getting started

### Prerequisites

- Node.js 20 or later
- pnpm 9 or later
- PostgreSQL and Redis, either locally or through managed services

### Install

```bash
git clone https://github.com/YuanshuoDu/applymate-jobcopilot.git
cd applymate-jobcopilot
pnpm install
```

### Configure the web app

Copy the template and fill in the values needed for your environment:

```bash
cp apps/web/.env.example apps/web/.env.local
```

At minimum, local development normally needs a PostgreSQL URL, `AUTH_SECRET`,
Google OAuth credentials, an AI provider configuration, and a Redis URL. Never
commit `.env.local` or provider credentials.

Production OAuth credential persistence requires all of these Azure variables:

```env
AZURE_KEY_VAULT_URL=
AZURE_KEY_NAME=applymate-credential-key
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
```

The Azure application must have the appropriate crypto role on the Key Vault.
`CREDENTIAL_ENCRYPTION_KEY` is a local development/test fallback, not a
replacement for the production Key Vault configuration.

### Prepare the database and run the web app

```bash
pnpm --filter @jobcopilot/web db:push
pnpm dev
```

### Build the Chrome Extension

```bash
pnpm --filter @jobcopilot/extension build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select `apps/extension/dist`.

## Deployment

The web app is deployed on Vercel at [applymate.site](https://applymate.site),
with a branch-linked preview at [preview.applymate.site](https://preview.applymate.site).
The Worker runs separately and consumes the shared queue and control
configuration described in the environment template.

Useful root-level commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For Extension changes, also run the Extension build and its targeted tests. For
Worker or browser changes, run the targeted integration and Playwright checks
described in the relevant documentation.

## Current boundaries and next work

- Broader direct ATS and source coverage
- Deeper Extension-to-Worker handoff for supported application workflows
- Screenshot/OCR support for forms and job descriptions that cannot be parsed reliably as text
- A future full auto-pilot mode only if it preserves approval, account isolation, and required user handoffs

## Contributing

1. Create a feature branch.
2. Keep changes focused and add tests for new behavior.
3. Run the relevant validation commands before opening a pull request.
4. Describe user-facing behavior, security boundaries, and known limitations in the pull request.
