# ApplyMate Admin Console Completion Design

> Status: draft for review
> Date: 2026-08-06
> Scope: web admin console, PostgreSQL/Prisma, candidate-safe support and notification APIs

## Objective

Make the ApplyMate administration surface operational for internal staff:

- dynamic administrator roles and permission assignments;
- masked candidate account management, suspension/restoration, plan assignment, and feature overrides;
- platform AI provider, model catalogue, default/fallback routing, and secret-reference health checks;
- editable commercial plan catalogue, entitlements, transition rules, manual plan changes, and audit history;
- existing broadcasts with a complete preview/filter workflow and idempotent delivery;
- Contact us case assignment, filtering, replies, internal notes, and lifecycle controls.

Stripe Checkout, Stripe webhooks, invoices, refunds, and customer self-service billing are explicitly deferred to a later design. Manual plan operations in this design are internal adjustments and never claim a Stripe payment has occurred.

## Security boundaries

The admin console is a separate surface under `/admin` and must never share candidate authorization assumptions. Every admin route, server component loader, and server action starts with `requireAdmin(permission)`.

The commercial `User.plan` value never grants internal privileges. Internal access comes only from an active `AdminMembership`, its role, and the requested permission. Roles use an allow-listed permission catalogue defined in code; the role-to-permission matrix and custom roles are stored in Prisma and editable by authorized administrators.

The following values are never selected, serialized, logged, exported, or returned through an admin API: password hashes, `UserApiKeys`, OAuth access/refresh tokens, browser profile state, resume or cover-letter content, Persona values, and Gmail message content. Controlled PII is masked in every admin DTO. Operational metadata is returned through hand-written selects only.

Every write requires CSRF validation, an `Idempotency-Key`, a 10-500 character reason, optimistic versioning where a resource has a version, and an append-only `AdminAuditLog` entry. The audit write is part of the same transaction as the side effect; if it fails, the side effect is rolled back.

## Delivery slices

1. **Security foundation**: admin roles/memberships, permission checks, JWT session-version invalidation, audit writer, masked DTO helpers, and the separate AdminShell.
2. **Users and plans**: masked user search/detail, account suspension/restoration, candidate feature overrides, plan catalogue and entitlements, transition rules, manual assignment history.
3. **Platform AI**: provider/model catalogue, default and fallback routing, per-feature route selection, secret references, credential status, bounded connection tests, and audit.
4. **Broadcasts and support**: finish the existing broadcast UI/API wiring and implement Contact us candidate/admin routes, assignment, filters, replies, notes, SLA, notifications, and audit.

Each slice is independently testable and deployable, but slices 2-4 depend on the security foundation. No ATS, queue, feature-flag, RLS, or Stripe work is added unless it is required by one of the requested workflows.

## Data model

### Security foundation

```prisma
enum AdminMembershipStatus { active suspended revoked }
enum AdminMfaLevel { none totp webauthn }
enum AdminAuditOutcome { success denied failed }
enum AdminTargetType { user admin_member admin_role plan plan_change ai_provider ai_model ai_route broadcast support_case }

model AdminRole {
  id          String   @id @default(cuid())
  key         String   @unique
  name        String
  description String?
  permissions String[]
  system      Boolean  @default(false)
  version     Int      @default(1)
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
  id            String             @id @default(cuid())
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
  before        Json?
  after         Json?
  errorCode     String?
  createdAt     DateTime           @default(now())
  @@index([actorUserId, createdAt(sort: Desc)])
  @@index([tenantUserId, createdAt(sort: Desc)])
  @@index([action, createdAt(sort: Desc)])
}

model AdminIdempotencyKey {
  id             String   @id @default(cuid())
  key            String
  actorUserId    String
  action         String
  requestHash    String
  responseStatus Int
  responseBody   Json
  createdAt      DateTime @default(now())
  @@unique([actorUserId, key])
  @@index([createdAt])
}
```

`User` receives `adminMembership AdminMembership? @relation("AdminUser")`. The first slice seeds the documented roles and an explicitly configured initial super-admin email; the seed refuses to create a second standing super-admin in production. Session revocation increments `sessionVersion`. The JWT callback includes the version for admin sessions, and `requireAdmin` compares it to the current membership on every request.

### Users and plans

The existing `Plan` enum remains the stable value on `User` for candidate compatibility. Add an account-state enum and explicit plan catalogue records:

```prisma
enum UserAccountStatus { active suspended }
enum PlanEntitlementKind { boolean limit text }

model PlanCatalog {
  id               String   @id @default(cuid())
  plan             Plan     @unique
  name             String
  description      String?
  monthlyPriceCents Int     @default(0)
  yearlyPriceCents  Int     @default(0)
  currency         String   @default("EUR")
  active            Boolean  @default(true)
  version           Int      @default(1)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  entitlements     PlanEntitlement[]
  fromTransitions  PlanTransition[] @relation("FromPlan")
  toTransitions    PlanTransition[] @relation("ToPlan")
}

model PlanEntitlement {
  id        String               @id @default(cuid())
  planId    String
  featureKey String
  kind      PlanEntitlementKind
  enabled   Boolean              @default(false)
  limit     Int?
  textValue String?
  plan      PlanCatalog          @relation(fields: [planId], references: [id], onDelete: Cascade)
  @@unique([planId, featureKey])
}

model PlanTransition {
  id        String      @id @default(cuid())
  fromPlan  Plan
  toPlan    Plan
  enabled   Boolean     @default(true)
  note      String?
  version   Int         @default(1)
  from      PlanCatalog @relation("FromPlan", fields: [fromPlan], references: [plan], onDelete: Restrict)
  to        PlanCatalog @relation("ToPlan", fields: [toPlan], references: [plan], onDelete: Restrict)
  @@unique([fromPlan, toPlan])
}

model UserPlanChange {
  id          String   @id @default(cuid())
  userId      String
  fromPlan    Plan
  toPlan      Plan
  reason      String
  actorUserId String
  createdAt   DateTime @default(now())
  @@index([userId, createdAt(sort: Desc)])
}

model UserFeatureOverride {
  id          String   @id @default(cuid())
  userId      String
  featureKey  String
  enabled     Boolean
  limit       Int?
  reason      String
  actorUserId String
  expiresAt   DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([userId, featureKey])
}
```

`User` gains `accountStatus`, `suspendedAt`, `suspendedById`, and `suspensionReason`. Candidate route authentication rejects suspended accounts. Manual plan changes validate an enabled `PlanTransition`, write `UserPlanChange`, update `User.plan`, and never write Stripe state.

### Platform AI configuration

```prisma
model AiProviderConfig {
  id                String   @id @default(cuid())
  key               String   @unique
  displayName       String
  apiBase           String
  secretRef         String?
  credentialConfigured Boolean @default(false)
  enabled           Boolean  @default(true)
  version           Int      @default(1)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  models            AiModelConfig[]
}

model AiModelConfig {
  id          String   @id @default(cuid())
  providerId  String
  model       String
  label       String
  description String?
  tier        String
  priceIn     Float    @default(0)
  priceOut    Float    @default(0)
  contextK    Int      @default(128)
  active      Boolean  @default(true)
  provider    AiProviderConfig @relation(fields: [providerId], references: [id], onDelete: Cascade)
  @@unique([providerId, model])
}

model AiRouteConfig {
  id              String   @id @default(cuid())
  featureKey      String   @unique
  defaultProvider String
  defaultModel    String
  fallbackProvider String?
  fallbackModel   String?
  version         Int      @default(1)
  updatedById     String
  updatedAt       DateTime @updatedAt
}
```

`secretRef` is an environment/secret-manager identifier such as `MINIMAX_API_KEY`; the raw value is resolved only inside the server-side model client. Admin APIs return only `credentialConfigured`, never the resolved key. Routes and models are versioned and reject inactive providers/models. Existing user-owned AI settings remain higher priority than platform defaults when valid.

### Broadcasts and Contact us

Use the existing notification table for delivery. Add `AdminBroadcast` with draft/approval/publish/cancel states, approved audience selectors, scheduled time, and delivery counters; add `broadcastId` plus a unique `(broadcastId, userId)` to `Notification` for retry idempotency.

Add `SupportCase` and `SupportCaseMessage` as described in `docs/admin-console-rbac-design.md`, including status, priority, assignment, SLA timestamps, safe context, message kind, and redaction marker. Staff replies create one `contact_us_reply` notification per idempotency key; internal notes never leave the admin API.

## API contracts

All endpoints use `/api/admin/v1`, `Cache-Control: no-store`, `x-request-id`, cursor pagination with a maximum limit of 100, and shared error codes.

### Access and permissions

- `GET /access/members`, `PATCH /access/members/:id`, `POST /access/members/:id/revoke-sessions`
- `GET /access/roles`, `POST /access/roles`, `PATCH /access/roles/:id`
- `GET /access/permissions` returns the allow-listed catalogue and domain labels.

Member writes validate active-role constraints, self-demotion rules, and optimistic versions. Role writes validate permission keys and preserve at least one active super-admin.

### Users and plans

- `GET /users` and `GET /users/:id`: masked identity plus plan, account state, resume/job/application counts, sync status, and audit timeline.
- `PATCH /users/:id/account-state`: suspend or restore with reason.
- `PATCH /users/:id/plan`: manual plan transition with reason and version.
- `GET/PATCH /users/:id/feature-overrides`: bounded feature/limit overrides with expiry.
- `GET/POST/PATCH /plans`, `/plans/:plan/entitlements`, `/plans/transitions`.

Plan catalogue writes are versioned and audited. A plan may be deactivated only when it is not the target of an enabled transition. Existing users retain their current enum value until an explicit change.

### Platform AI

- `GET/POST/PATCH /ai/providers` manages provider metadata and secret references.
- `GET/POST/PATCH /ai/providers/:id/models` manages the model catalogue.
- `GET/PATCH /ai/routes` manages default/fallback model selection by feature.
- `POST /ai/providers/:id/test` resolves the configured secret internally and makes one bounded request, returning status, latency, and model identifier only.

Provider test errors are classified and truncated; request/response bodies and keys are never persisted.

### Broadcasts and support

Broadcast endpoints implement create, preview, approve, publish, schedule, and cancel. Preview returns only recipient count and k-anonymized plan/location aggregates. Contact us endpoints implement candidate-owned case creation/replies and admin queue/detail/assignment/status/reply/note/escalation operations, with filter query parameters for status, priority, assignment, category, and SLA state.

## UI information architecture

Use a dedicated `AdminShell` with a compact left navigation and permission-aware menu items. Routes include `/admin`, `/admin/access`, `/admin/users`, `/admin/users/:id`, `/admin/plans`, `/admin/ai`, `/admin/broadcasts`, and `/admin/contact-us`.

The access page defaults to the role-first editor selected during brainstorming and includes a read-only matrix tab. User detail uses metadata summary rows and explicit action confirmation for suspension or plan changes. AI pages show configuration status, never secrets. Plans expose prices, entitlements, transitions, and change history. Contact us uses the existing design's three-pane desktop layout and responsive queue/conversation/context behavior; the Filter button is wired to URL state.

## Testing and rollout

Every new source module has a sibling Vitest file. Tests cover permission matrix resolution, denied/suspended members, JWT version invalidation, redaction against forbidden fields, audit failure rollback, user ownership, plan transitions, AI secret non-disclosure, provider test bounds, broadcast approval/idempotency, support isolation, secret redaction, notification ownership, and filter behavior. No tests call live provider or Stripe endpoints.

Rollout order is security foundation, read/write user and plans, AI configuration, then broadcast/support completion. Existing `/api/admin/observability` is either protected by the new authorization layer or removed in favor of the versioned route before the admin shell links to it.
