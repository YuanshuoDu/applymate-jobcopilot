# ApplyMate AI

<p align="center">
  <img src="docs/assets/readme/hero.png" alt="ApplyMate AI — Your next role. One connected workspace." width="1000" />
</p>

<p align="center">
  <strong>An AI job-search copilot for the European market.</strong><br />
  Discover roles, prepare application materials, and keep track of every opportunity in one workspace.
</p>

<p align="center">
  <a href="https://applymate.site"><strong>Open ApplyMate</strong></a> ·
  <a href="https://preview.applymate.site">Preview</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/YuanshuoDu/applymate-jobcopilot/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/YuanshuoDu/applymate-jobcopilot/actions/workflows/ci.yml"><img src="https://github.com/YuanshuoDu/applymate-jobcopilot/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-15-0b1220?style=flat&amp;logo=next.js&amp;logoColor=white" alt="Next.js 15" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-0b1220?style=flat&amp;logo=react&amp;logoColor=61dafb" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-0b1220?style=flat&amp;logo=typescript&amp;logoColor=60a5fa" alt="TypeScript" /></a>
</p>

<p align="center">
  <a href="#the-application-loop">Workflow</a> ·
  <a href="#capabilities">Capabilities</a> ·
  <a href="#agent-harness">Agent Harness</a> ·
  <a href="#safety-and-availability">Safety</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation-and-contributing">Docs and contributing</a>
</p>

---

## Why ApplyMate

Job searching spans job boards, career portals, document editors, and email.
ApplyMate brings role discovery, application preparation, and follow-up into
one workspace for candidates applying across European markets.

## The application loop

![Three connected stages: discover and match roles; prepare materials and approve each job; apply through supported ATS workflows and track replies. Login, MFA, CAPTCHA, and missing answers pause for the candidate.](docs/assets/readme/workflow.svg)

1. **Discover and shortlist** — search job sources and compare roles with your profile.
2. **Prepare and review** — tailor a resume and cover letter, then review the application pack.
3. **Apply and follow up** — use assisted filling or a supported ATS workflow, then track job-related replies.

## Capabilities

| Capability | What it does | Availability and limits |
| --- | --- | --- |
| **Discover roles** | Search job sources and ATS portals; compare normalized descriptions, locations, fit scores, and keywords. | Source and employer coverage varies. |
| **Manage your profile** | Parse PDF or DOCX resumes and maintain reusable profile details and tailored versions. | Web app; supported formats and fields apply. |
| **Prepare applications** | Create role-specific resumes and cover letters, then review and download application packs. | Requires an AI provider configured for the feature. |
| **Use the Chrome Extension** | Capture career-page jobs, sync saved jobs, preview materials, and assist with form fields. | Candidate must be present in the browser. |
| **Run ATS workflows** | Queue application tasks with checkpoints and candidate handoffs. | Worker includes Workday, Greenhouse, Lever, SmartRecruiters, and Personio flows; coverage varies by form, account, and available profile data. |
| **Follow replies** | Track job-related messages and prepare follow-up drafts for review. | Requires a Gmail connection. |

An application can pause for a missing answer, login, MFA, CAPTCHA, or another
candidate-only step. **Final submission requires approval for the specific job.**

## Agent Harness

The repository includes an Agent Harness V2 implementation for typed sessions,
turns, task planning, worker coordination, tools, and evidence-based completion.
It uses a provider-neutral model contract, durable state, and explicit policy and
approval boundaries.

```mermaid
flowchart LR
  goal[User goal or input] --> plan[Root plans a TaskGraph]
  plan --> workers[Worker-managed tasks]
  workers --> gate{Policy and approval gate}
  gate -->|Allowed| tools[Approved tools]
  gate -->|Approval needed| candidate[Candidate approves this job]
  candidate --> gate
  tools --> verify[Verify recorded evidence]
  verify -->|Incomplete or failed| plan
  verify -->|Ready| result[Result or review checkpoint]

  state[(Durable Session, Turn, Task, and Event state)]
  plan <--> state
  workers <--> state
  gate --> state
  tools <--> state
  verify --> state
```

| Runtime capability | What is implemented | Source |
| --- | --- | --- |
| **Durable continuity** | Typed Sessions and Turns record inputs, steps, items, events, and execution state for continuation and replay. | [Agent protocol](packages/agent-protocol/src/) · [Prisma models](apps/web/prisma/schema.prisma) |
| **Task planning and workers** | TaskGraphs plan bounded child work; Worker tasks coordinate through persisted state and typed tools. | [TaskGraph runtime](apps/worker/src/runtime/subagents/) · [Worker startup](apps/worker/src/index.ts) |
| **Pause, resume, and retry** | User input, approval, interruption, and retry commands operate on owned sessions and turns with revision, lease, and budget controls. | [Session controls](apps/web/src/app/api/agent/sessions/) · [Turn recovery](apps/worker/src/runtime/turns/) |
| **Bounded context and history** | Typed snapshots, selected-job facts, and task outcomes carry relevant context into later steps; compaction and cross-session history have separate runtime gates. | [Context and history](apps/worker/src/runtime/context/) |
| **Evidence-based completion** | TaskGraph completion checks required evidence and criteria; failed or unverified work can return to planning. | [Completion gate](apps/worker/src/runtime/turns/turn-execution-completion-gate.ts) · [TaskGraph verification](apps/worker/src/runtime/subagents/task-graph-pg-verification.ts) |
| **Scheduled workflows** | Scheduled automations use persisted Turns; scheduled discovery supports multi-Scout cohorts through Audit. | [Automation scheduler](apps/web/src/app/api/agent/automations/due/route.ts) · [Scheduled pipeline](apps/worker/src/runtime/canonical-turn-scheduled-pipeline.ts) |

These capabilities are implemented in the repository, but not all are enabled
in every environment. Some runtime capabilities remain feature-flagged or
environment-gated. Legacy agent and automation paths remain in source during
migration and use their existing policy controls. Source code does not establish
deployment, current production flag state, staging acceptance, or general
availability. See the [V2 technical
design](docs/agent-harness-v2-technical-design.md), [development
roadmap](docs/agent-harness-v2-development-roadmap.md), [Phase 4 exit
report](docs/agent-harness-v2/gates/phase-4/exit-report.md), and [GA
checklist](docs/ga/agent-harness-2.0-checklist.md) for implementation and
release evidence.

### AI providers and your own API key

The Web app's ModelRouter supports user-supplied API keys for configured
providers and features. When no user key is set, it can use a platform key if
one is configured. The Agent Harness has provider-neutral contracts and a set of
adapters; available models and capabilities depend on the feature and adapter.
The repository does not promise that every model works with every agent path.

## Safety and availability

| Boundary | How ApplyMate handles it |
| --- | --- |
| **Application approval** | Final submission requires an explicit approval bound to the specific job and application materials. |
| **Candidate-only steps** | Login, MFA, CAPTCHA, and missing answers remain visible handoffs. |
| **Account ownership** | Connected accounts and application data are scoped to the owning candidate. |
| **Credentials** | Production OAuth credential persistence uses Azure Key Vault; secrets stay outside source control. |

## Architecture

Three product surfaces share the application workflow:

| Surface | Responsibility | Code |
| --- | --- | --- |
| **Web app** | Discovery, profiles, tailoring, approvals, Gmail tracking, and run history. | [apps/web](apps/web) |
| **Chrome Extension** | In-page job capture, saved-job sync, material preview, and assisted filling. | [apps/extension](apps/extension) |
| **Worker** | Queue-backed tasks, browser workflows, checkpoints, and pacing. It runs as a separate process. | [apps/worker](apps/worker) |

| Layer | Stack |
| --- | --- |
| Web | Next.js App Router · React · TypeScript · Tailwind CSS |
| Extension | Vite · React · Chrome Manifest V3 |
| Data and queues | PostgreSQL · Prisma · BullMQ · Redis |
| Browser workflows | Playwright-compatible automation · ATS-specific flow modules |
| Identity and credentials | Auth.js / NextAuth · Google OAuth · Azure Key Vault |
| AI | ModelRouter and provider-neutral Agent Harness model contracts |

<details>
<summary><strong>Explore the repository</strong></summary>

```text
applymate-jobcopilot/
├── apps/
│   ├── web/              # Web app and API routes
│   ├── extension/        # Chrome Extension
│   └── worker/           # Queue workers and ATS workflows
├── packages/
│   ├── agent-model/      # Model contracts and provider adapters
│   ├── agent-policy/     # Agent policy contracts
│   ├── agent-protocol/   # Typed runtime contracts
│   └── shared/           # Shared types and utilities
├── docs/                 # Architecture, API, and runbooks
└── e2e/                  # Playwright end-to-end tests
```

</details>

## Quick start

### Requirements

- Node.js 20 or newer
- pnpm 10.33.2 (the version pinned by this repository)
- A local PostgreSQL database for development

### Install and configure

```bash
git clone https://github.com/YuanshuoDu/applymate-jobcopilot.git
cd applymate-jobcopilot
pnpm install --frozen-lockfile
```

Use [apps/web/.env.example](apps/web/.env.example) as a reference for Web
settings. Next.js loads local Web values from `apps/web/.env.local`; keep that
file out of Git. Configure only the provider credentials and connected services
you intend to use.

### Build and run the Web app

Use a **local development database only** with `db:push`. In PowerShell, set
`DATABASE_URL` in the same terminal before running the Prisma commands. For
Bash or zsh, use the `export` form below.

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/applymate"
```

```sh
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/applymate"
```

Prisma CLI reads `DATABASE_URL` from the process environment; setting it in
`.env.local` alone is not sufficient for these commands.

```sh
pnpm --filter './packages/*' build
pnpm --filter @jobcopilot/web db:generate
pnpm --filter @jobcopilot/web db:push
pnpm --filter @jobcopilot/web dev
```

The commands build the shared packages, generate the Prisma client, update the
local schema, and start the Web app at [localhost:3000](http://localhost:3000).
The `DATABASE_URL` above is an example; use the connection string for your own
local database. **Never point `db:push` at production.**

The Web command starts only the Web app. The Worker is a separate process. To
run it locally, provide its required environment variables to the process, then
start it in another terminal:

```sh
pnpm --filter @jobcopilot/worker dev
```

The [Worker environment template](apps/worker/.env.example) documents its
PostgreSQL, Redis, and shared-secret settings; it does not load them for you.
See the [auto-apply deployment guide](docs/auto-apply-deployment.md) and
[operations runbook](docs/runbook.md) for separate Worker setup and operations.

<details>
<summary><strong>Build and load the Chrome Extension</strong></summary>

```bash
pnpm --filter @jobcopilot/extension build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select `apps/extension/dist`.

</details>

<details>
<summary><strong>Run project checks</strong></summary>

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For Worker, Extension, or browser changes, use the relevant focused and
integration checks in the developer documentation.

</details>

## Documentation and contributing

| Resource | Description |
| --- | --- |
| [Documentation index](docs/README.md) | Maintained documentation map. |
| [Agent Harness V2 design](docs/agent-harness-v2-technical-design.md) | Runtime contracts, tools, approvals, and recovery. |
| [Agent Harness V2 roadmap](docs/agent-harness-v2-development-roadmap.md) | Implementation gates, verification, rollout, and rollback. |
| [Discovery and auto-apply design](docs/scraping-autoapply-design.md) | Source discovery, enrichment, and ATS workflow architecture. |
| [Developer guide](docs/scraping-autoapply-dev-guide.md) | Coding standards and integration guidance. |
| [API reference](docs/api-reference.md) | Routes, authentication, and payloads. |
| [Auto-apply deployment guide](docs/auto-apply-deployment.md) | Separate Worker deployment and configuration. |
| [Operations runbook](docs/runbook.md) | Queue, Worker, and production operations. |
| [Contributing](.github/CONTRIBUTING.md) | How to propose and review changes. |
| [Support](.github/SUPPORT.md) | Where to ask questions and report problems. |

To contribute, create a focused branch, add coverage for changed behavior, run
the relevant checks, and describe user-visible changes and limitations. Read
the [GitHub collaboration guide](docs/github-collaboration.md) before changing
agent or application workflow code.

---

<p align="center">
  <strong>Find your fit. Prepare with care. Keep moving.</strong><br />
  <a href="https://applymate.site">Open ApplyMate</a> · <a href="docs/README.md">Explore the docs</a>
</p>
