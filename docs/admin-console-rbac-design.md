# ApplyMate Internal Admin Console, Platform Controls, and Data Isolation

> Status: implementation specification, v2
> Scope: `apps/web`, PostgreSQL/Prisma, existing notification APIs, and Worker control plane
> Security principle: **deny by default; enforce on the server; least privilege; tenant isolation; immutable audit trail.**

## 1. Purpose and non-negotiable boundaries

ApplyMate needs an internal console for platform operations: user support, ATS source health, feature controls, AI-budget operations, queue health, platform broadcasts, and security review. It is not a candidate-facing feature and must not share the candidate application shell or authorization model.

The following rule is absolute: **no administrator, including `super_admin` or a break-glass operator, may read a candidate's API keys, password hash, OAuth refresh token, full resume, or email body.** These fields must never be selected, serialized, logged, audited, exported, or made available through a support tool. Operational pages may expose only approved metadata such as “resume exists”, a document size, a Gmail sync status, or a job count.

The console may publish platform messages to users' in-app `Notification` records. It must not inspect private candidate content in order to compose, target, or deliver a broadcast.

Out of scope for v1: B2B organizations, self-service internal-user invitations, arbitrary database queries, arbitrary Redis commands, direct Bull Board access, and sending broadcasts by email.

## 2. Existing-system baseline and required compatibility

The product currently uses NextAuth v5. A session contains `user.id` and `user.plan`; it has no internal-role claim. Candidate API routes use `requireAuth()` and must keep enforcing ownership by `userId`. `User.plan` is a commercial plan and **must never confer an internal privilege**.

Existing resources that the console must adapt rather than replace:

| Existing component | Current behavior | Admin-compatible change |
|---|---|---|
| `User`, `Job`, `Resume`, Persona/Gmail Prisma models | Candidate data is owned by `userId`. | Keep ownership model. Add separate admin tables and use admin-only, metadata-only DTOs. |
| `/api/notifications` | Reads the authenticated candidate's last 30 days of `notifications`; `/mark-read` updates only that user's rows. | Broadcast deliveries are standard `Notification` rows, so they appear and can be marked read without changing candidate authorization. |
| `/api/me/ai-budget` | Reads the caller's `ai_budgets` row for the current month. | Keep it candidate-only. The console gets a separate aggregate/read/write admin API with reason and audit controls. |
| `/api/admin/observability` | Currently reads all `apply_results` without an admin check. | Treat as a security defect: move/replace with `/api/admin/v1/observability`, require `observability.read`, and remove unauthenticated access before console launch. |
| `AtsEmployer`, `ApplyResult`, `FormPattern`, `AiBudget` | Existing Prisma models support ATS registry sightings, apply outcomes, pattern cache, and monthly budget. | Do not duplicate them. Add controlled operational configuration and expose only safe aggregates. |
| Worker queues | BullMQ queues: `apply-tasks` and `scout-tasks`; Worker currently starts Bull Board at `/admin/queues`. | The web app calls a signed, allow-listed Worker control API. Bull Board is private, disabled by default, and never embedded in the console. |

## 3. Architecture and isolation model

```mermaid
flowchart LR
  Candidate[Candidate] --> CandidateAPI[Candidate APIs: requireAuth + userId filter]
  Staff[Internal staff + MFA] --> AdminUI[/admin]
  AdminUI --> AdminAPI[/api/admin/v1]
  AdminAPI --> Authz[requireAdmin permission + scope]
  Authz --> SafeRepo[Metadata-only repositories]
  SafeRepo --> DB[(PostgreSQL)]
  AdminAPI --> Audit[append-only AdminAuditLog]
  AdminAPI --> WorkerClient[Signed Worker control client]
  WorkerClient --> Worker[apply-tasks / scout-tasks]
  Broadcast[Approved broadcast] --> Notifications[(notifications)]
  CandidateAPI --> Notifications
```

Isolation is mandatory at three layers.

1. **Route layer:** `/admin/**` and `/api/admin/v1/**` require an internal session. Middleware can redirect early but is never the only control.
2. **Service layer:** every admin operation calls `requireAdmin(permission)`. Every candidate repository query receives the authenticated `userId` as a required parameter and includes it in the database predicate.
3. **Data layer:** candidate fields are returned through explicit, allow-listed selects. In phase 3, PostgreSQL row-level security (RLS) provides defense in depth for `Job`, `Resume`, `CoverLetter`, `Notification`, `ApplyResult`, Persona, and Gmail tables.

An identifier alone never authorizes access. For example, a candidate job lookup must be `where: { id: jobId, userId }`, not an `id` lookup followed by a JavaScript comparison.

## 4. Roles, permissions, and approval separation

### 4.1 Roles

| Role | Intended use | Boundary |
|---|---|---|
| `support` | Candidate support | Masked user metadata and relevant operational status only. No broadcasts, subscription changes, queue actions, or private content. |
| `operations` | Day-to-day platform operations | Source/queue/apply diagnostics and retry requests; can draft a broadcast but cannot approve or publish it. |
| `analyst` | Product/data analysis | Read-only aggregates and anonymized exports. No individual candidate browsing. |
| `billing` | Commercial support | Plans and billing annotations only. No jobs, applications, resumes, Gmail, or secrets. |
| `security_admin` | Access and incident management | Roles, sessions, audits, and break-glass approvals. No default business write access. |
| `platform_admin` | Limited senior operations | Platform configuration and approval/publish of broadcasts. Cannot read prohibited private content. |
| `super_admin` | Emergency platform owner, maximum two standing members | Broad platform control, WebAuthn and recent reauthentication required. The prohibited-data rule still applies. |

Roles do not inherit by default. A role is an explicit allow-list of permissions, not a UI label.

### 4.2 Permission catalogue

| Domain | Permissions |
|---|---|
| Users | `users.read`, `users.read_pii_masked`, `users.suspend`, `users.restore`, `users.export_anonymized` |
| Billing | `billing.read`, `billing.update`, `billing.refund_mark` |
| Jobs/applications | `jobs.read_metadata`, `jobs.read_content_masked`, `applications.read`, `applications.retry`, `applications.cancel`, `applications.manual_review` |
| ATS operations | `ats.read`, `ats.update`, `ats.pause`, `ats.resume`, `ats.test`, `ats.registry.manage` |
| Feature controls | `feature_flags.read`, `feature_flags.update`, `feature_flags.approve` |
| AI budgets | `ai_budget.read`, `ai_budget.update`, `ai_budget.reset` |
| Worker | `queues.read`, `queues.retry`, `queues.pause`, `queues.resume` |
| Broadcasts | `broadcasts.create`, `broadcasts.update`, `broadcasts.preview`, `broadcasts.approve`, `broadcasts.publish`, `broadcasts.cancel` |
| Security | `admin_members.read`, `admin_members.manage`, `admin_roles.manage`, `sessions.revoke`, `audit.read`, `break_glass.request`, `break_glass.approve` |
| System | `observability.read`, `incidents.manage` |

There is deliberately no permission for secret retrieval, full-resume download, email-body retrieval, arbitrary SQL, or arbitrary queue execution. Break-glass grants may add only a defined operational permission for at most 30 minutes; they cannot grant a nonexistent forbidden-data permission.

## 5. Data model and migrations

Add these Prisma models to `apps/web/prisma/schema.prisma`. Do not add `User.isAdmin Boolean`.

```prisma
enum AdminMembershipStatus { active suspended revoked }
enum AdminMfaLevel { none totp webauthn }
enum AdminAuditOutcome { success denied failed }
enum AdminTargetType { user job application ats_source feature_flag ai_budget queue broadcast admin_member }
enum BroadcastStatus { draft pending_approval scheduled publishing published cancelled failed }
enum BroadcastAudienceType { all_active_users plan location explicit_user_ids }

model AdminRole {
  id          String   @id @default(cuid())
  key         String   @unique
  name        String
  description String?
  permissions String[]
  system      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  memberships AdminMembership[]
}

model AdminMembership {
  id             String                @id @default(cuid())
  userId         String                @unique
  roleId         String
  status         AdminMembershipStatus @default(active)
  mfaLevel       AdminMfaLevel         @default(none)
  sessionVersion Int                   @default(1)
  grantedById    String?
  grantedAt      DateTime              @default(now())
  revokedAt      DateTime?
  user           User                  @relation("AdminUser", fields: [userId], references: [id], onDelete: Restrict)
  role           AdminRole             @relation(fields: [roleId], references: [id], onDelete: Restrict)
  @@index([status, roleId])
}

model AdminAuditLog {
  id            String            @id @default(cuid())
  requestId     String
  actorUserId   String?
  actorRoleKey  String?
  action        String
  targetType    AdminTargetType?
  targetId      String?
  tenantUserId  String?
  reason        String?
  outcome       AdminAuditOutcome
  ipHash        String?
  userAgentHash String?
  before        Json?              // allow-listed, non-sensitive fields only
  after         Json?              // allow-listed, non-sensitive fields only
  errorCode     String?
  createdAt     DateTime          @default(now())
  @@index([actorUserId, createdAt(sort: Desc)])
  @@index([tenantUserId, createdAt(sort: Desc)])
  @@index([action, createdAt(sort: Desc)])
}

model AdminBreakGlassGrant {
  id          String   @id @default(cuid())
  requesterId String
  approverId  String?
  permission  String
  reason      String
  expiresAt   DateTime
  revokedAt   DateTime?
  createdAt   DateTime @default(now())
  @@index([requesterId, expiresAt])
}

model AdminBroadcast {
  id             String                @id @default(cuid())
  title          String
  body           String                @db.Text
  audienceType   BroadcastAudienceType
  audience       Json                  // only approved filters or user IDs; no PII snapshot
  status         BroadcastStatus       @default(draft)
  scheduledAt    DateTime?
  createdById    String
  approvedById   String?
  publishedById  String?
  recipientCount Int                   @default(0)
  deliveredCount Int                   @default(0)
  failedCount    Int                   @default(0)
  createdAt      DateTime              @default(now())
  updatedAt      DateTime              @updatedAt
  notifications  Notification[]
  @@index([status, scheduledAt])
}
```

Add `adminMembership AdminMembership? @relation("AdminUser")` to `User`. Extend the existing `Notification` model—not a parallel delivery table—with `broadcastId String?`, an `AdminBroadcast?` relation, `@@unique([broadcastId, userId])`, and an index on `broadcastId`. PostgreSQL permits multiple null values in that composite unique index, so existing non-broadcast notifications remain unaffected.

Use a distinct migration for each concern: admin identity/audit, broadcast delivery, and RLS. Seed roles through a one-time controlled script; it must require a specific initial super-admin email and refuse to run in production when a super admin already exists.

## 6. Sensitive-data contract

| Classification | Examples | Admin API rule |
|---|---|---|
| Never accessible | `User.password`, `Account.access_token`, `Account.refresh_token`, `UserApiKeys`, browser profiles/cookies | Never select, log, audit, export, or expose. |
| Never accessible as content | Resume body/file, cover-letter body, `PersonaFact` value, Gmail message subject/body/snippet/attachment | Return existence/status/size/count only. No exception for super admins or incidents. |
| Controlled PII | Email, name, phone, location, LinkedIn/GitHub URL | Support sees masked values. Unmasking requires a separate future permission, reason, and legal approval; it is not part of v1. |
| Operational metadata | Plan, created time, job/application status, ATS type, error code, counts, budget usage | Return only when the requested permission permits it. |

Admin data transfer objects must be hand-written, with explicit Prisma `select` clauses. Never use `include: { user: true }`, a `select` spread, or a serialized Prisma entity in an admin route. Centralize redaction in `apps/web/src/lib/admin/dto.ts` and unit test it against every forbidden field.

## 7. Console information architecture

Use a separate `AdminShell` and routes below `/admin`.

| Page | Route | Permission | Content |
|---|---|---|---|
| Overview | `/admin` | `observability.read` | Registration, plan, source, queue, and application aggregates; alerts. |
| Users | `/admin/users` | `users.read` | Search and masked metadata; no private documents or emails. |
| User detail | `/admin/users/[id]` | `users.read` | Metadata, job/apply counts, sync status, notification metadata, audit timeline. |
| ATS sources | `/admin/ats` | `ats.read` | Registry, source health, rate limit, error class, lag, and controlled actions. |
| Applications | `/admin/applications` | `applications.read` | Outcome/error metadata and allowed retry/cancel/manual-review actions. |
| Queues | `/admin/queues` | `queues.read` | Queue aggregates and controlled queue actions, not Bull Board. |
| AI operations | `/admin/ai` | `ai_budget.read` | Aggregate spend/usage, exceptions, monthly limits, model health. |
| Feature flags | `/admin/platform` | `feature_flags.read` | Environment-scoped flags, rollout state, approval history. |
| Broadcasts | `/admin/broadcasts` | `broadcasts.create` | Draft, anonymous audience preview, approval, scheduling, delivery results. |
| Audit/security | `/admin/audit` | `audit.read` | Append-only events, access denials, break-glass, config changes. |
| Access | `/admin/access` | `admin_members.manage` | Members, roles, MFA status, session revocation. |

## 8. ATS source administration

### 8.1 Goals and data sources

ATS administration manages discovery health and safe operating policy, not candidate data. It uses existing `AtsEmployer` (`atsType`, `slug`, `name`, `firstSeen`, `lastSeen`, `jobCount`) plus discovery logs/metrics. Current supported source families include Greenhouse, Lever, Workday, SmartRecruiters, Personio, and existing paid/fallback sources.

Create an `AtsSourcePolicy` configuration table keyed by a stable `sourceKey` such as `greenhouse`, `lever`, or `workday-cxs`. It must contain only operational settings:

```text
sourceKey, enabled, rolloutPercent, globalRpsLimit, perTenantRpsLimit,
maxRetries, backoffBaseMs, allowAutoApply, lastChangedById, version, updatedAt
```

Do not store third-party credentials in this table. Source credentials stay in the platform secret store and are represented in the console only by `credentialConfigured: boolean`.

### 8.2 Source states and allowed transitions

| State | Meaning | Who may change it | Effect |
|---|---|---|---|
| `enabled` | New discovery work can be scheduled. | `ats.update` | Standard rate policy applies. |
| `degraded` | Automatic retries/backoff active. | Worker only | Admin is alerted; no manual bypass of rate limits. |
| `paused` | No new jobs; in-flight work may finish safely. | `ats.pause` + approval | Scheduler stops new work. |
| `disabled` | Source blocked due to compliance/security/ToS. | `platform_admin` + second approver | Scheduler and auto-apply refuse it. |

No console control may increase a source above the documented hard limits in `apps/web/src/lib/agent/pace/policies.ts`. Changes lowering limits can be self-service; increases require an approved code/config deployment and an audit event. A “test source” action makes one synthetic, no-candidate request against a fixed test employer or mocked health endpoint; it must not run an unbounded crawl.

### 8.3 ATS API and worker integration

| Method | Endpoint | Permission | Rule |
|---|---|---|---|
| GET | `/api/admin/v1/ats` | `ats.read` | Registry and aggregates only; cursor pagination. |
| GET | `/api/admin/v1/ats/:sourceKey/health` | `ats.read` | Last success, failure classes, p95 latency, lag, rate-limit events; no raw job descriptions. |
| PATCH | `/api/admin/v1/ats/:sourceKey/policy` | `ats.update` | Versioned allow-listed policy update; reason, idempotency key, audit. |
| POST | `/api/admin/v1/ats/:sourceKey/pause` | `ats.pause` | Requires reason and second approval for a global source. |
| POST | `/api/admin/v1/ats/:sourceKey/resume` | `ats.resume` | Validates compliance state, policy version, and queue health. |
| POST | `/api/admin/v1/ats/:sourceKey/test` | `ats.test` | One bounded diagnostic request; result contains status and timing only. |

The web app writes the desired policy transactionally and publishes a signed configuration-change message. Discovery workers read the policy before enqueueing and before outbound requests. A worker acknowledges the version; the console displays “pending propagation” until acknowledged. This avoids a UI claiming a source is paused while a stale worker keeps scheduling it.

## 9. Feature flags and AI-budget operations

### 9.1 Feature flags

Add a `PlatformFeatureFlag` model with `key`, `environment`, `enabled`, `rolloutPercent`, optional allow-listed `plan`/`userId` targeting, `version`, `updatedById`, and timestamps. Do not put secrets, dynamic JavaScript, or arbitrary JSON rules in feature flags.

Flags have `draft -> pending_approval -> active -> retired` states. The creator cannot approve their own flag change. Production changes to auto-apply, CAPTCHA, payment, authentication, or source compliance require a second approver and a scheduled rollback time. Candidate APIs and workers resolve flags from a cached, versioned read-only snapshot; they must default safely to disabled if the flag service is unavailable.

### 9.2 AI budgets

Existing `AiBudget` is per user/month (`used`, `limit`) and the Worker increments it for AI fallback. The console must preserve this accounting model.

- `GET /api/admin/v1/ai/budgets` returns aggregates and user metadata only: month, plan, used, limit, remaining, and reason history. It never returns user API keys, model prompts, or model outputs.
- `PATCH /api/admin/v1/ai/budgets/:userId/:month` accepts a new limit, optimistic `version`, and reason. Only bounded plan-policy overrides are allowed; reducing below `used` requires a confirmation and results in zero remaining credits.
- `POST /api/admin/v1/ai/budgets/:userId/:month/reset` requires `ai_budget.reset`, second approval, and creates an immutable adjustment record rather than overwriting usage silently.
- Worker `checkBudget` and `incrementBudget` remain the source for actual consumption. Admin mutations must use the same transaction/locking mechanism so a console update cannot race an apply worker.

## 10. Broadcasts to existing notifications

An approved platform broadcast writes a row per recipient to the existing `notifications` table using `type = 'platform_broadcast'`, `title`, `body`, `user_id`, and `broadcast_id`. It is an in-app message only. Existing `GET /api/notifications` already filters by the authenticated `user_id`, so the candidate can see their message; `PATCH /api/notifications/mark-read` continues to enforce that same ownership condition.

Allowed audience selectors are `all_active_users`, plan, location, and an explicit `userId` list. Do not target on email, resume, persona, Gmail data, job text, application error, or any other private content. Audience preview returns only recipient count and plan/location aggregates meeting k-anonymity (recommended `k >= 20`); it does not return emails or a recipient list.

| Method | Endpoint | Permission | Control |
|---|---|---|---|
| POST | `/api/admin/v1/broadcasts` | `broadcasts.create` | Create draft, title <= 120 chars, body <= 2,000 chars, sanitized Markdown/plain text only. |
| POST | `/:id/preview` | `broadcasts.preview` | Anonymous count/distribution only. |
| POST | `/:id/approve` | `broadcasts.approve` | Creator cannot approve. |
| POST | `/:id/publish` | `broadcasts.publish` | Approved only; second confirmation, idempotency key, audit, enqueue batches. |
| POST | `/:id/cancel` | `broadcasts.cancel` | Stops unstarted batches; never deletes already-delivered notifications. |

The broadcast worker uses `(broadcast_id, user_id)` uniqueness to make batch retries idempotent. It records counts and classified errors, not a PII recipient snapshot. Product/marketing broadcasts must respect future notification preferences; service outage, legal, and security messages can be policy-defined as mandatory.

## 11. API, authorization, and Worker control contract

All new admin endpoints live under `/api/admin/v1`. They use cursor pagination, maximum limit 100, `x-request-id`, and `Cache-Control: no-store`. Every write requires CSRF validation, an `Idempotency-Key`, validated input, and a 10–500 character `reason`.

Create `apps/web/src/lib/admin/`:

```text
permissions.ts       Permission union and built-in role maps
authorization.ts     requireAdmin, MFA/session-version/break-glass checks
audit.ts              append-only audit writer and safe snapshots
dto.ts                allow-listed metadata DTOs and redaction tests
csrf.ts               write-request validation
ats-service.ts        versioned ATS policy operations
feature-flags.ts      versioned safe flag resolution
budget-service.ts     locking-aware budget adjustments
broadcast-service.ts  audience query, approval, batch enqueue
worker-client.ts      signed, allow-listed Worker commands
```

`requireAdmin(permission)` obtains `safeAuth()`, loads the active `AdminMembership` and `AdminRole`, verifies MFA/session version/permission, and returns an immutable actor object. It audits denial as well as success. It must be the first executable operation in every Route Handler, Server Action, and admin Server Component data loader.

The Worker control plane must never expose Redis, Bull Board, arbitrary job payloads, or browser profiles. The web service sends a short-lived HMAC- or mTLS-authenticated command containing `requestId`, timestamp, nonce, actor ID, action, reason, and allow-listed parameters. The Worker rejects stale/replayed commands, records its own structured event, and returns a command receipt. Supported commands are queue summary, pause/resume queue, retry a known eligible job, and apply an acknowledged ATS policy version.

`apps/worker/src/index.ts` must change so Bull Board does not start unless an explicit development-only flag is enabled. In production it must bind to loopback/private network and sit behind an identity-aware proxy; missing `BULL_BOARD_PASSWORD` must deny access, never permit it.

## 12. Audit and observability

Every admin authentication, authorization denial, read of controlled PII metadata, write, export, configuration change, broadcast state change, queue action, role change, session revocation, and break-glass event is written to `AdminAuditLog`.

Audit records contain actor, role, request ID, target type/ID, candidate `userId` when affected, action, reason, outcome, hashed IP/user agent, and allow-listed before/after fields. They never include the prohibited fields or private candidate content. Application database credentials have INSERT/SELECT only on the audit table; no UPDATE/DELETE. A daily hash-chain checkpoint is stored in isolated logging infrastructure. Audit write failure fails closed for an admin write: the side effect does not run.

The existing observability aggregation over `apply_results` is useful, but must be authenticated and extended safely. It may expose totals, success rate, flow distribution (`programmatic`, `pattern-cache`, `llm`), duration, CAPTCHA rate, and ATS aggregates. It must not expose job URLs, error text containing candidate content, screenshots, HAR files, or worker raw payloads. Add alerts for audit-write failures, unauthorized-admin spikes, use of super-admin/break-glass, source/queue pause, flag change, bulk broadcast, Worker command verification failure, and abnormal AI-budget changes.

## 13. Security controls

- Administrators require WebAuthn where possible; `super_admin` requires WebAuthn and reauthentication within 15 minutes for high-risk actions.
- Use secure, HttpOnly, SameSite cookies, CSRF tokens, Origin/Referer validation, strict CSP, dual user/IP rate limits, and no-store caching for admin pages.
- Web app, Worker, and candidate services use separate least-privilege credentials and secrets. No secret belongs in Prisma data, feature flags, audit data, or logs.
- Export is aggregate and anonymized by default. Any future user-level export requires a separate reviewed design, encryption, short-lived download URL, legal basis, retention, and audit event.
- Store screenshots/HARs in private storage, authorize per object, and enforce lifecycle deletion. They are never shown in the standard console.
- RLS rollout must set `SET LOCAL app.user_id` only inside a transaction. Restricted admin views/functions return safe metadata; an admin DB role is not an unrestricted RLS bypass.

## 14. Tests and release acceptance

| Test level | Required coverage |
|---|---|
| Unit | Permission matrix; disabled membership; session version; MFA; break-glass expiry/self-approval; redaction; audit snapshot filtering; forbidden fields absent for every role. |
| API integration | 401/403/success for every endpoint; CSRF; idempotency; pagination cap; version conflict; audit success/denial; no secret/content in payloads or errors. |
| Tenant isolation | Candidate A cannot read/update/delete candidate B resources, including guessed nested IDs. |
| Broadcast | Creator cannot approve/publish; preview is anonymous; duplicate batch retry creates one notification; candidate can read/mark only their own delivery. |
| ATS/AI/flags | State transitions, rate-limit ceiling, worker version acknowledgement, budget race safety, flag approval/rollback. |
| Worker | Signed command verification, nonce replay rejection, allowed-command enforcement, Bull Board disabled in production. |
| RLS | Cross-tenant SQL under candidate DB identity returns no rows; restricted admin view excludes forbidden fields. |
| E2E/security | Each role's UI and forged API requests; IDOR, CSRF, session invalidation after role change, OWASP access-control regression. |

Release is blocked until all of these are true:

- No administrator, including super admin and break-glass, can obtain API keys, password hashes, refresh tokens, full resumes, or email bodies via API, export, log, audit, repository, or database view.
- Every admin write has reason, idempotency, CSRF, audit, and appropriate approval; audit failure blocks the write.
- Broadcasts produce only `Notification` rows, use recipient deduplication, and cannot use private content for targeting.
- The unauthenticated observability route and publicly reachable Bull Board are removed/secured.
- Candidate ownership filters and the RLS migration plan are tested and approved.

## 15. Delivery plan

1. **Security baseline:** secure Bull Board, protect current observability, inventory and test candidate `userId` filters.
2. **Identity and audit:** migrations, role seeds, `requireAdmin`, MFA/session revocation, append-only audit library, safe DTOs.
3. **Read-only console:** dashboard, users, ATS health, applications, audit pages using existing safe aggregates.
4. **Controlled operations:** ATS policies, queue commands, AI budgets, feature flags, broadcast workflow and batch delivery.
5. **Defense in depth:** RLS, restricted views, export/retention policy, external security review, incident drill, quarterly access review.

Each implementation issue must name the required permission, permitted fields, audit action, failure mode, compatibility impact on current APIs/Worker, and at least one cross-tenant or privilege-escalation test.
