# Agent Session Quality & Auto-Apply Redesign

> **Status:** Draft v1 · 2026-06-18
> **Audience:** Product, Design, Codex, Claude reviewer, future contributors
> **Related:** [`agent-workspace-redesign.md`](./agent-workspace-redesign.md), [`scraping-autoapply-design.md`](./scraping-autoapply-design.md), [`scraping-autoapply-dev-guide.md`](./scraping-autoapply-dev-guide.md)
> **External reference:** [`santifer/career-ops`](https://github.com/santifer/career-ops)

This spec upgrades ApplyMate's Agent system from a fixed pipeline plus chat endpoint into a replayable, auditable, quality-gated `AgentSession` runtime.

The UI should still look like a Claude-style workspace, but the deeper change is architectural: the Orchestrator becomes the session owner, subagents become task workers with strict contracts, and every risky auto-apply action passes through gates, approvals, reducers, and transcript events.

---

## 1. Why This Change

Current state:

- `OrchestratorAgent` already plans, evaluates, retries, asks the user, and aborts.
- `scout / analyst / writer / reviewer / executor / auditor` already exist, but mostly behave like fixed pipeline stages.
- `/api/agent/chat` is a chat channel with `ACTION:` text parsing.
- `/api/agent/run` is an execution SSE channel.
- `AgentRun` stores logs, but not a strong session contract.

Target state:

```text
AgentSession
  ├─ Orchestrator
  │   ├─ decomposes work
  │   ├─ assigns SubAgentTask
  │   ├─ reads structured results
  │   ├─ decides proceed / retry / ask_user / abort
  │   └─ updates session memory
  │
  ├─ SubAgentTask[]
  │   ├─ input contract
  │   ├─ expected output schema
  │   ├─ quality gate
  │   └─ result / failure reason
  │
  └─ Transcript
      ├─ user message
      ├─ orchestrator plan
      ├─ subagent result
      ├─ thinking summary
      ├─ approval block
      └─ final report
```

The biggest improvement is not making the model "smarter." It is making the model's job narrower, the output typed, and the Orchestrator's decisions measurable.

---

## 2. Borrowed Principles From career-ops

ApplyMate should not copy the CLI implementation, but should borrow these operating-system ideas:

| career-ops pattern | ApplyMate adaptation |
|---|---|
| User Layer vs System Layer data contract | Separate `Persona / Resume / Preferences / Application History` from `Agent Runtime / Prompts / Flows / Pattern Cache`. User-owned data is never mutated by runtime updates. |
| Mode/skill as task protocol | Replace loose role prompts with `SubAgentTask` packages: `goal`, `constraints`, `successCriteria`, `context`, `allowedActions`, output schema. |
| Liveness gate before AI spend | Add `LivenessGate` before scoring, tailoring, and applying. Anti-bot pages must become `uncertain`, not `expired`. |
| Evaluation as decision report | Upgrade job scoring into `JobDecision` with score, legitimacy, readiness, stops, gaps, evidence, and decision. |
| Self-contained batch worker prompt | Every subagent task receives complete context and a strict output schema. No hidden dependency on conversation memory. |
| Tracker merge integrity | Subagents do not directly mutate final business state. They return typed results; a reducer updates `Job.status`, `ApplyResult`, and session memory. |

Reference evidence:

- career-ops separates user-owned files from system-owned files in `DATA_CONTRACT.md`.
- `liveness-core.mjs` treats anti-bot challenges and access-blocked pages as `uncertain`, not expired.
- `batch-prompt.md` says the worker prompt is self-contained and emits a machine-readable summary for downstream scripts.

---

## 3. Data Ownership Contract

ApplyMate should make data ownership explicit.

### User Layer

Runtime upgrades must not rewrite these except through explicit user action:

- `Persona`
- `Resume`
- user preferences
- application history
- Gmail/mail history
- user-authored notes
- saved target roles and locations
- approvals and rejections

### System Layer

These can be updated by product releases and migrations:

- Orchestrator prompt templates
- subagent task definitions
- quality gate definitions
- ATS flow implementations
- form-pattern cache schema
- discovery source adapters
- reducer logic
- transcript renderers
- observability calculations

### Runtime Layer

These are created during execution:

- `AgentSession`
- `SubAgentTask`
- `AgentTranscriptEvent`
- `AgentApproval`
- `JobDecision`
- `ApplyAttempt`
- `SessionQualityReport`

Runtime data can reference user data, but should not overwrite user data directly.

---

## 4. Core Domain Model

### AgentSession

```ts
type AgentSessionStatus =
  | 'draft'
  | 'running'
  | 'waiting_for_user'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted'

interface AgentSession {
  id: string
  userId: string
  goal: string
  status: AgentSessionStatus
  source: 'chat' | 'automation' | 'manual_run' | 'system'
  memorySummary: string
  qualityScore: number | null
  currentTaskId: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}
```

### SubAgentTask

```ts
type SubAgentRole =
  | 'orchestrator'
  | 'scout'
  | 'analyst'
  | 'writer'
  | 'reviewer'
  | 'executor'
  | 'auditor'

type SubAgentTaskStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'retrying'
  | 'waiting_for_user'
  | 'skipped'

interface SubAgentTask {
  id: string
  sessionId: string
  role: SubAgentRole
  taskType: string
  status: SubAgentTaskStatus
  goal: string
  constraints: string[]
  successCriteria: string[]
  allowedActions: string[]
  context: unknown
  expectedOutputSchema: unknown
  result: unknown | null
  confidence: number | null
  failureReason: string | null
  qualityGateResult: QualityGateResult | null
  createdAt: string
  updatedAt: string
}
```

### AgentTranscriptEvent

```ts
type TranscriptEventType =
  | 'user_message'
  | 'orchestrator_plan'
  | 'subagent_task_started'
  | 'subagent_result'
  | 'thinking_summary'
  | 'quality_gate'
  | 'approval_request'
  | 'approval_response'
  | 'automation_draft'
  | 'job_results'
  | 'session_memory'
  | 'final_report'
  | 'error'

interface AgentTranscriptEvent {
  id: string
  sessionId: string
  taskId: string | null
  type: TranscriptEventType
  speaker: string
  title: string | null
  body: string
  data: unknown
  createdAt: string
  durationMs: number | null
}
```

### JobDecision

```ts
interface JobDecision {
  jobId: string
  matchScore: number
  legitimacyTier: 'high_confidence' | 'proceed_with_caution' | 'suspicious'
  applyReadiness: 'ready' | 'needs_review' | 'blocked'
  hardStops: string[]
  softGaps: string[]
  evidence: Array<{
    source: 'resume' | 'job_description' | 'company' | 'history' | 'liveness'
    quoteOrSignal: string
    weight: 'low' | 'medium' | 'high'
  }>
  finalDecision: 'apply' | 'review' | 'skip'
  confidence: number
}
```

### QualityGateResult

```ts
interface QualityGateResult {
  gate: string
  status: 'passed' | 'failed' | 'uncertain'
  score: number
  retryRecommended: boolean
  askUserRecommended: boolean
  hitMissReason: string
  evidence: string[]
}
```

---

## 5. Required Gates

The auto-apply chain should become:

```text
Job selected
  → LivenessGate
  → JobDecisionGate
  → ApplyPreflight
  → FlowDetector
  → PatternReplay
  → ProgrammaticFlow
  → AgentHarness fallback
  → SensitiveFieldGate
  → SubmitConfidenceGate
  → ApplyResultReducer
  → SessionQualityReport
```

### LivenessGate

Purpose: verify the job is still live before spending AI tokens or attempting to apply.

Inputs:

- URL
- expected company
- expected role/title
- final URL after navigation
- body text summary
- visible apply controls
- HTTP status

Outputs:

```ts
type LivenessResult =
  | { status: 'active'; confidence: number; evidence: string[] }
  | { status: 'expired'; confidence: number; reason: string; evidence: string[] }
  | { status: 'uncertain'; confidence: number; reason: string; evidence: string[] }
```

Rules:

- HTTP 404/410 can be expired.
- Hard expired text can be expired.
- Visible apply control is active.
- Anti-bot, CAPTCHA, Cloudflare, short challenge pages, 403, and 503 are uncertain, not expired.
- Redirect to generic careers search is suspicious unless company/title still match.

### JobDecisionGate

Purpose: decide whether the role is worth applying to.

Inputs:

- full job description
- resume/persona summary
- target roles and locations
- salary preferences
- liveness result
- prior application history

Output: `JobDecision`

Hard stops examples:

- location incompatible
- salary far below minimum
- visa/work authorization mismatch
- role clearly not aligned
- suspicious/low-legitimacy posting
- duplicate application

### ApplyPreflight

Purpose: ensure the application attempt has enough information to start.

Checks:

- resume selected
- persona complete enough for likely fields
- cover letter available or generation allowed
- apply URL direct enough
- per-user and per-domain rate limits not exceeded
- no blocked source domain

### SensitiveFieldGate

Purpose: prevent guessing on high-risk fields.

Sensitive field classes:

- visa/work authorization
- legal attestations
- salary expectations if user did not configure a range
- demographic / self-identification
- disability / veteran status
- background check / conviction questions
- relocation commitments
- notice period if absent from persona

Outputs:

- `passed` when known.
- `ask_user` when missing or ambiguous.
- `blocked` when answer would require guessing.

### SubmitConfidenceGate

Purpose: final check before clicking submit.

Checks:

- required fields filled
- uploaded files visible
- current page still matches expected company/job
- submit button semantics are clear
- no visible error banners
- no CAPTCHA wall
- no sensitive unanswered fields
- confirmation screenshot can be captured

Minimum submit confidence:

- programmatic known ATS: `0.85`
- pattern replay: `0.80`
- AgentHarness fallback: `0.90`

---

## 6. Orchestrator Responsibilities

The Orchestrator owns decisions. Subagents produce typed results.

Orchestrator loop:

```text
1. Read session goal and memory summary.
2. Create next SubAgentTask with strict input contract.
3. Run task.
4. Validate task output against schema.
5. Run quality gate.
6. Decide:
   - proceed
   - retry with refined context
   - ask_user
   - abort
7. Write transcript event.
8. Update session memory summary.
```

Rules:

- Subagents do not directly update `Job.status`.
- Subagents do not directly submit applications.
- Subagents do not silently answer sensitive fields.
- The Orchestrator or a reducer performs durable business-state writes.
- Every retry records why the previous attempt missed.

---

## 7. SubAgent Task Contract

Every task receives:

```ts
interface SubAgentTaskInput<TContext> {
  sessionId: string
  taskId: string
  role: SubAgentRole
  goal: string
  constraints: string[]
  successCriteria: string[]
  allowedActions: string[]
  context: TContext
  expectedOutputSchemaName: string
}
```

Every task returns:

```ts
interface SubAgentTaskOutput<TResult> {
  status: 'completed' | 'failed' | 'needs_user'
  result: TResult | null
  confidence: number
  evidence: string[]
  failureReason: string | null
  nextRecommendedAction:
    | 'proceed'
    | 'retry'
    | 'ask_user'
    | 'abort'
}
```

Task prompt requirements:

- self-contained context
- no dependency on hidden conversation memory
- explicit output schema
- explicit failure JSON
- explicit stop conditions
- explicit disallowed actions

---

## 8. API Consolidation Plan

Current:

- `/api/agent/chat` for chat and text-parsed `ACTION:`
- `/api/agent/run` for execution SSE
- `/api/agent/history` for historical runs

Target:

```text
POST /api/agent/sessions
GET  /api/agent/sessions
GET  /api/agent/sessions/[id]
POST /api/agent/sessions/[id]/messages
GET  /api/agent/sessions/[id]/events
POST /api/agent/sessions/[id]/actions
POST /api/agent/sessions/[id]/tasks
```

Compatibility:

- Keep `/api/agent/chat` as a thin adapter that creates or continues an `AgentSession`.
- Keep `/api/agent/run` as a thin adapter that starts a `manual_run` session and streams `AgentTranscriptEvent`.
- Keep `/api/agent/history` until the UI migrates to `GET /api/agent/sessions`.

Event stream:

```text
event: transcript
data: { "type": "orchestrator_plan", ... }

event: task
data: { "taskId": "...", "status": "running", ... }

event: quality_gate
data: { "gate": "LivenessGate", "status": "passed", ... }

event: approval
data: { "approvalId": "...", "status": "pending", ... }
```

---

## 9. Database Design

Suggested Prisma additions:

```prisma
model AgentSession {
  id              String   @id @default(cuid())
  userId          String
  goal            String
  status          String
  source          String
  memorySummary   String   @default("")
  qualityScore    Float?
  currentTaskId   String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  completedAt     DateTime?

  tasks           SubAgentTask[]
  transcript      AgentTranscriptEvent[]
  approvals       AgentApproval[]
}

model SubAgentTask {
  id                   String   @id @default(cuid())
  sessionId            String
  role                 String
  taskType             String
  status               String
  goal                 String
  constraints          Json
  successCriteria      Json
  allowedActions       Json
  context              Json
  expectedOutputSchema Json
  result               Json?
  confidence           Float?
  failureReason        String?
  qualityGateResult    Json?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  session              AgentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
}

model AgentTranscriptEvent {
  id          String   @id @default(cuid())
  sessionId   String
  taskId      String?
  type        String
  speaker     String
  title       String?
  body        String
  data        Json?
  durationMs  Int?
  createdAt   DateTime @default(now())

  session     AgentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
}

model AgentApproval {
  id          String   @id @default(cuid())
  sessionId   String
  taskId      String?
  userId      String
  type        String
  status      String   @default("pending")
  title       String
  body        String
  impact      Json?
  payload     Json
  decidedAt   DateTime?
  createdAt   DateTime @default(now())

  session     AgentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
}
```

Future additions:

- `AgentAutomation`
- `JobDecision`
- `ApplyAttempt`
- `SessionQualityReport`

Migration rule:

- Existing `AgentRun` can be preserved as legacy history.
- New runs should write both legacy `AgentRun` and `AgentSession` during migration.
- After UI migration, `AgentRun` can become a compatibility view or deprecated model.

---

## 10. UI Redesign: Session Quality Console

The updated UI should extend the existing Claude-style workspace.

### Left Pane

Replace simple agent list with a session console:

```text
New session

Recent Sessions
- Berlin SWE Auto-Apply
  Running · Quality 87 · 7 tasks · 2 approvals
- Amsterdam PM Scout
  Completed · Quality 91 · 5 tasks

Agent Team
- Orchestrator   planning       MiniMax M2.7
- Scout          LivenessGate   94%
- Analyst        JobDecision    89%
- Writer         idle
- Reviewer       waiting
- Executor       approval
- Auditor        queued

Queued Tasks
- LivenessGate          running
- JobDecisionGate       queued
- SensitiveFieldGate    waiting
- SubmitConfidenceGate  blocked

Approvals
- 4 applications waiting
- 1 automation change

Session Quality
Quality 87 · Retry 8% · Gate pass 92% · Hit/miss logged
```

### Right Transcript

Must show:

- user message
- orchestrator plan
- subagent result
- quality gate result
- thinking summary
- approval request
- final report

Example transcript flow:

```text
You
每天早上 9 点自动找 Berlin 软件工程岗位，85 分以上自动投，但需要我确认。

09:01
```

```text
Orchestrator · Plan
I will create a session with these gates:
LivenessGate → JobDecisionGate → ApplyPreflight → SensitiveFieldGate → SubmitConfidenceGate.

09:01 · 1.2s
```

```text
Scout · LivenessGate result
active: true
companyTitleMatch: true
confidence: 0.94
evidence: visible apply control, title match, no expired banner

09:02 · 3.8s
```

```text
Analyst · JobDecision
Match score: 91
Legitimacy: High confidence
Apply readiness: Ready
Hard stops: none
Soft gaps: 2
Decision: apply

09:03 · 6.4s
```

```text
Quality Gate · Passed
Gate: JobDecisionGate
Score: 0.89
Retry: not needed
Hit/miss reason: strong resume match with no hard stop

09:03
```

```text
Orchestrator · Approval Required
Submit 4 applications?

Impact: 4 applications · 4 cover letters · no LinkedIn · sensitive fields require user answer

[Approve] [Review] [Cancel]

09:04
```

### Session Memory Strip

Right header should include a small memory strip:

```text
Memory: target Berlin SWE · min score 85 · approval required · no LinkedIn
```

This makes long sessions understandable and reduces drift.

---

## 11. Implementation Phases

### Phase 1 — Session Models and Write Path

Goal: introduce `AgentSession`, `SubAgentTask`, and `AgentTranscriptEvent` without breaking current UI.

Tasks:

- Add Prisma models.
- Add session repository helpers.
- Add transcript writer.
- Add compatibility write from `/api/agent/run` into both `AgentRun` and `AgentSession`.
- Add unit tests for session creation and transcript append.

Acceptance:

- Starting a manual run creates an `AgentSession`.
- SSE events are mirrored into `AgentTranscriptEvent`.
- Existing `AgentHistoryPage` still works.

### Phase 2 — SubAgentTaskRunner Wrapper

Goal: wrap existing fixed stages with task contracts.

Tasks:

- Create `SubAgentTaskRunner`.
- Define schemas for scout, analyst, writer, reviewer, executor, auditor.
- Convert each stage output into typed `SubAgentTask.result`.
- Add quality gate adapter.

Acceptance:

- Each stage emits a `SubAgentTask`.
- Each task has goal, constraints, success criteria, output schema, result, confidence.
- Failed stage records failure reason.

### Phase 3 — Quality Gates for Auto-Apply

Goal: improve hit rate and avoid bad submissions.

Tasks:

- Add `LivenessGate`.
- Add `JobDecisionGate`.
- Add `ApplyPreflight`.
- Add `SensitiveFieldGate`.
- Add `SubmitConfidenceGate`.
- Add tests for active, expired, uncertain, anti-bot, sensitive-field, and low-confidence cases.

Acceptance:

- Closed jobs do not continue to apply.
- Anti-bot pages become uncertain, not expired.
- Sensitive unanswered fields create an approval/question, not guessed answers.
- Submit is blocked below confidence threshold.

### Phase 4 — Unified Session API

Goal: merge chat and execution into the same session contract.

Tasks:

- Add `/api/agent/sessions`.
- Add `/api/agent/sessions/[id]/messages`.
- Add `/api/agent/sessions/[id]/events`.
- Add `/api/agent/sessions/[id]/actions`.
- Make `/api/agent/chat` and `/api/agent/run` adapters.
- Replace `ACTION:` text parsing with structured action/block events.

Acceptance:

- A chat can create a session.
- A run can continue a session.
- Transcript events stream from one endpoint.
- UI can replay a session without special history transforms.

### Phase 5 — Session Quality UI

Goal: update the Agent page to show the new architecture.

Tasks:

- Left pane: Recent Sessions, Agent Team, Queued Tasks, Approvals, Session Quality.
- Right pane: transcript events from `AgentTranscriptEvent`.
- Add session memory strip.
- Add quality gate block.
- Add subagent result block.
- Add approval block wired to `/actions`.

Acceptance:

- User sees Orchestrator assigning tasks.
- User sees subagent structured results.
- User sees quality gate pass/fail/uncertain states.
- User can approve/reject in transcript.
- User can replay completed sessions.

### Phase 6 — Automations on AgentSession

Goal: make scheduled automations create sessions instead of separate ad-hoc runs.

Tasks:

- Add `AgentAutomation`.
- Scheduled automation creates `AgentSession` with `source = automation`.
- Automation run writes the same transcript and task records.
- Left automation list links to generated sessions.

Acceptance:

- Manual and scheduled runs share one session model.
- Automation-created sessions can be replayed.
- Approval requests from automations appear in the same Approvals section.

---

## 12. File-Level Development Plan

Likely new backend files:

```text
apps/web/src/lib/agent/session/types.ts
apps/web/src/lib/agent/session/repository.ts
apps/web/src/lib/agent/session/transcript.ts
apps/web/src/lib/agent/session/task-runner.ts
apps/web/src/lib/agent/session/quality.ts
apps/web/src/lib/agent/gates/liveness.ts
apps/web/src/lib/agent/gates/job-decision.ts
apps/web/src/lib/agent/gates/apply-preflight.ts
apps/web/src/lib/agent/gates/sensitive-field.ts
apps/web/src/lib/agent/gates/submit-confidence.ts
```

Likely new API files:

```text
apps/web/src/app/api/agent/sessions/route.ts
apps/web/src/app/api/agent/sessions/[id]/route.ts
apps/web/src/app/api/agent/sessions/[id]/messages/route.ts
apps/web/src/app/api/agent/sessions/[id]/events/route.ts
apps/web/src/app/api/agent/sessions/[id]/actions/route.ts
```

Likely UI files:

```text
apps/web/src/components/agent-workspace/SessionSidebar.tsx
apps/web/src/components/agent-workspace/RecentSessionsList.tsx
apps/web/src/components/agent-workspace/QueuedTasksList.tsx
apps/web/src/components/agent-workspace/ApprovalsList.tsx
apps/web/src/components/agent-workspace/SessionQualityStrip.tsx
apps/web/src/components/agent-workspace/SessionMemoryStrip.tsx
apps/web/src/components/agent-workspace/SubAgentResultBlock.tsx
apps/web/src/components/agent-workspace/QualityGateBlock.tsx
```

Tests:

```text
apps/web/src/lib/agent/session/*.test.ts
apps/web/src/lib/agent/gates/*.test.ts
apps/web/src/app/api/agent/sessions/**/*.test.ts
apps/web/src/components/agent-workspace/*.test.tsx
```

---

## 13. Quality Metrics

Each session should compute:

```ts
interface SessionQualityReport {
  sessionId: string
  qualityScore: number
  totalTasks: number
  passedTasks: number
  failedTasks: number
  retriedTasks: number
  approvalCount: number
  gatePassRate: number
  retryRate: number
  averageConfidence: number
  hitMissReasons: string[]
  hardStops: string[]
  recommendations: string[]
}
```

Use these metrics for:

- left-pane Session Quality
- final report transcript block
- prompt/routing improvement
- future dashboard rollups

---

## 14. PR and Issue Slicing

Recommended issue sequence:

1. `feat(agent-session): add AgentSession transcript models`
2. `feat(agent-session): mirror /api/agent/run into transcript events`
3. `feat(agent-session): add SubAgentTaskRunner wrapper`
4. `feat(agent-gates): add LivenessGate`
5. `feat(agent-gates): add JobDecisionGate`
6. `feat(agent-gates): add ApplyPreflight and SensitiveFieldGate`
7. `feat(agent-gates): add SubmitConfidenceGate`
8. `feat(agent-api): add session endpoints`
9. `refactor(agent-chat): replace ACTION parsing with structured events`
10. `feat(agent-ui): add Session Quality Console left pane`
11. `feat(agent-ui): render subagent result and quality gate blocks`
12. `feat(agent-ui): wire approvals to session actions`
13. `feat(agent-automation): run automations as AgentSessions`

Each issue should include:

- exact model/API/component files in scope
- schema definitions
- acceptance criteria
- tests required
- migration/backward compatibility notes

---

## 15. Design QA Checklist

- Left pane says `Recent Sessions`, not just `Agent History`.
- Left pane includes `Queued Tasks`, `Approvals`, and `Session Quality`.
- Agent Team rows show current task state and confidence.
- Right transcript shows Orchestrator assigning work.
- Subagent result blocks show structured results, not free text only.
- Quality gates are visible and auditable.
- Session memory is visible near the header.
- Approval remains inline.
- Composer remains Claude-like with plus button and model selector.
- No top-right mode/run/stop controls return.
- Message speaker remains above content.
- Time remains below content.

---

## 16. Open Questions

1. Should `AgentSession` replace `AgentRun` immediately, or mirror writes for one release?
2. Should quality gates live in `apps/web` first, or should auto-apply gates live in `apps/worker` and web only display results?
3. Should `JobDecision` be persisted as its own model or stored as `SubAgentTask.result` initially?
4. Should approvals reuse `AgentRunQuestion` during migration or move directly to `AgentApproval`?
5. Should the Orchestrator prompt be split into small task-specific system prompts or one session controller prompt plus task templates?

---

## 17. Summary

The recommended path is backend architecture first, then UI wiring:

```text
AgentSession foundation
  → SubAgentTask contracts
  → quality gates
  → unified session APIs
  → Session Quality Console UI
  → automations as sessions
```

This is the version that will improve ApplyMate's hit rate and stability. The UI becomes more Claude-like because the backend becomes more Claude Code-like: one main Orchestrator, typed subagent work, auditable gates, clear approvals, and replayable sessions.
