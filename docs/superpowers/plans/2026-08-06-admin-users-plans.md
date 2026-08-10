# Admin Users And Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Make the admin console operational for masked user account controls, a database-backed plan catalogue with entitlements and transitions, manual plan changes, feature overrides, and immutable audit history without Stripe state.

**Architecture:** Keep the existing `Plan` enum as the candidate-facing compatibility value. Add explicit catalogue, entitlement, transition, plan-change, and feature-override records; all admin writes use `requireAdmin`, same-origin CSRF, persisted idempotency, a 10-500 character reason, optimistic versions, and a transaction-local audit entry. User DTOs use explicit selects and masked identity fields and never load secrets or candidate content.

**Tech Stack:** Next.js 15 App Router route handlers, React client components, Prisma/PostgreSQL, Vitest, existing admin security helpers.

---

### Task 1: Add account and plan catalogue schema

**Files:**
- Modify: `apps/web/prisma/schema.prisma`
- Create: `apps/web/prisma/migrations/20260806210000_add_admin_users_plans/migration.sql`
- Create: `apps/web/prisma/admin-users-plans-schema.test.ts`

- [ ] **Step 1: Write a failing schema smoke test** that asserts Prisma validation and generated delegates for `PlanCatalog`, `PlanEntitlement`, `PlanTransition`, `UserPlanChange`, and `UserFeatureOverride`, plus `User.accountStatus`.
- [ ] **Step 2: Run the smoke test before the schema edit** and confirm the missing-model failure.
- [ ] **Step 3: Add `UserAccountStatus`, `PlanEntitlementKind`, and the five models** from the approved admin design. Add `accountStatus`, `suspendedAt`, `suspendedById`, and `suspensionReason` to `User`; keep `User.plan` unchanged. Use unique plan/feature and transition pairs, restrict plan references, and cascade only entitlements/overrides where ownership is explicit.
- [ ] **Step 4: Add the equivalent PostgreSQL migration** with enum types, tables, indexes, constraints, and a unique active transition pair. Do not alter existing candidate tables beyond the new user columns.
- [ ] **Step 5: Run `prisma validate` and `prisma generate`** with a temporary `DATABASE_URL`; run the schema smoke test and commit `feat(admin): add user and plan catalogue schema`.

### Task 2: Add plan catalogue domain validation

**Files:**
- Create: `apps/web/src/lib/admin/plans.ts`
- Create: `apps/web/src/lib/admin/plans.test.ts`

- [ ] **Step 1: Write failing tests** for price/currency validation, entitlement boolean/limit/text shapes, transition rejection when target is inactive, and feature override bounds/expiry.
- [ ] **Step 2: Implement pure validators** that normalize EUR prices to non-negative integer cents, restrict currencies to three uppercase letters, reject unknown entitlement kinds, require limits only for `limit`, require text only for `text`, and reject expired override dates.
- [ ] **Step 3: Implement `planDto`, `entitlementDto`, `transitionDto`, and `manualPlanChangeDto` from explicit input shapes only; never accept Prisma objects as unrestricted records.
- [ ] **Step 4: Run the focused tests and commit `feat(admin): validate plan catalogue inputs`.

### Task 3: Implement masked user APIs

**Files:**
- Create: `apps/web/src/app/api/admin/v1/users/route.ts`
- Create: `apps/web/src/app/api/admin/v1/users/route.test.ts`
- Create: `apps/web/src/app/api/admin/v1/users/[id]/route.ts`
- Create: `apps/web/src/app/api/admin/v1/users/[id]/route.test.ts`
- Create: `apps/web/src/app/api/admin/v1/users/[id]/account-state/route.ts`
- Create: `apps/web/src/app/api/admin/v1/users/[id]/account-state/route.test.ts`

- [ ] **Step 1: Write route tests first** for cursor-limited masked search, account detail counts, suspension/restore, user ownership isolation, no secret/content selects, CSRF, idempotency, reason validation, and audit rollback.
- [ ] **Step 2: Implement `GET /users`** with a maximum limit of 100, email/name search, plan/status filters, explicit masked user select, and metadata counts for resumes/jobs/application tasks.
- [ ] **Step 3: Implement `GET /users/:id`** with the same safe identity and operational counts plus plan/account status and recent safe plan-change summaries; return 404 for unknown IDs.
- [ ] **Step 4: Implement `PATCH /users/:id/account-state`** with `users.suspend`/`users.restore`, active/suspended transition validation, optimistic `updatedAt` check, idempotency, and audit snapshots containing only status/reason codes.
- [ ] **Step 5: Run focused route tests and commit `feat(admin): add masked user management api`.

### Task 4: Implement plan catalogue and entitlement APIs

**Files:**
- Create: `apps/web/src/app/api/admin/v1/plans/route.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/route.test.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/[plan]/route.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/[plan]/route.test.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/[plan]/entitlements/route.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/[plan]/entitlements/route.test.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/transitions/route.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/transitions/route.test.ts`

- [ ] **Step 1: Write failing tests** for catalogue list/create/update, entitlement replacement, transition enable/disable, optimistic version conflicts, deactivation protection for enabled target transitions, and audit/idempotency/CSRF on every write.
- [ ] **Step 2: Implement `GET/POST /plans`** with billing.read/billing.update and explicit catalogue DTOs; seed free/pro/enterprise records only when absent.
- [ ] **Step 3: Implement `PATCH /plans/:plan`** for metadata and active/version changes; refuse deactivation while an enabled transition targets the plan.
- [ ] **Step 4: Implement `GET/PATCH /plans/:plan/entitlements`** as a versioned replace operation, validating each feature key and kind, in one transaction with audit.
- [ ] **Step 5: Implement `GET/PATCH /plans/transitions`** with enabled transition validation and no Stripe writes.
- [ ] **Step 6: Run the focused API tests and commit `feat(admin): add plan catalogue api`.

### Task 5: Implement manual plan changes and feature overrides

**Files:**
- Create: `apps/web/src/app/api/admin/v1/users/[id]/plan/route.ts`
- Create: `apps/web/src/app/api/admin/v1/users/[id]/plan/route.test.ts`
- Create: `apps/web/src/app/api/admin/v1/users/[id]/feature-overrides/route.ts`
- Create: `apps/web/src/app/api/admin/v1/users/[id]/feature-overrides/route.test.ts`

- [ ] **Step 1: Write failing tests** for enabled transition enforcement, manual assignment history, same-plan no-op rejection, suspended-user restrictions, bounded feature keys/limits, expiry, idempotent replay, and audit records without billing claims.
- [ ] **Step 2: Implement `PATCH /users/:id/plan`** with billing.update, an enabled `PlanTransition` lookup, atomic `User.plan` update plus `UserPlanChange` insert, optimistic user `updatedAt`, and an audit target of `plan_change`.
- [ ] **Step 3: Implement `GET/PATCH /users/:id/feature-overrides`** with a bounded allow-list of feature keys, boolean/limit values, expiry, upsert semantics, and audit-safe snapshots.
- [ ] **Step 4: Run focused tests and commit `feat(admin): add manual plan and override controls`.

### Task 6: Build users and plans admin UI

**Files:**
- Create: `apps/web/src/components/admin/UsersPage.tsx`
- Create: `apps/web/src/components/admin/UsersPage.test.ts`
- Create: `apps/web/src/components/admin/PlansPage.tsx`
- Create: `apps/web/src/components/admin/PlansPage.test.ts`
- Create: `apps/web/src/app/admin/users/page.tsx`
- Create: `apps/web/src/app/admin/users/[id]/page.tsx`
- Create: `apps/web/src/app/admin/plans/page.tsx`

- [ ] **Step 1: Write pure view-model tests** for masked rows, status badges, entitlement editing, transition display, and plan-change history formatting.
- [ ] **Step 2: Implement the users list/detail UI** with URL-backed search/filter state, explicit suspension/restore confirmation, plan selector, feature override editor, and no candidate content preload.
- [ ] **Step 3: Implement the plans UI** with catalogue tabs, EUR monthly/yearly cents, entitlement editors, transition controls, and manual adjustment audit history; every write sends an idempotency key and reason.
- [ ] **Step 4: Run component tests and typecheck; commit `feat(admin): add users and plans console`.

### Task 7: Security regression and handoff

**Files:**
- Create: `apps/web/src/__tests__/api/admin-users-plans-regression.test.ts`

- [ ] **Step 1: Add regression tests** forging candidate plan values, guessed nested IDs, stale timestamps, unknown feature keys, and forbidden secret/content fields; assert every request is denied or redacted.
- [ ] **Step 2: Run `pnpm --filter web test`, `pnpm --filter web exec tsc --noEmit --skipLibCheck`, `git diff --check`, and `pnpm --filter web exec prisma validate` with a temporary `DATABASE_URL`.
- [ ] **Step 3: Review selects against the forbidden-field list and confirm no Stripe tables, keys, or payment claims are added.
- [ ] **Step 4: Commit test/doc changes, push `feat/admin-security-foundation` to origin, and prepare the required PR body with Layer 1 and Layer 2 tables.

## Plan self-review

- Coverage includes masked users, account status, plan catalogue, entitlements, transitions, manual changes, overrides, UI, audit, and security regression; Stripe is explicitly excluded.
- All writes name their reason, idempotency, CSRF, optimistic version, and transaction-local audit behavior.
- Every new TypeScript source has a sibling test file; route handlers use Next 15 `Promise` params.
