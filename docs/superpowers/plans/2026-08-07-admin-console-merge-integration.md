# Admin Console and Settings Merge Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge the settings/admin wiring branch with the upstream RBAC admin console while preserving every working candidate-settings integration and making user settings management a least-privilege, audited admin workflow.

**Architecture:** `origin/master` is the source of truth for admin authentication, navigation, audit logging, and operational pages. Candidate settings remain owned by `/api/me`; the admin surface consumes only the masked settings DTO and uses the same `requireAdmin`/`isAdminResponse`/`writeAdminAudit` primitives as every other admin endpoint. Legacy environment-variable allow-lists and the retired observability page are removed rather than kept as alternate paths.

**Tech Stack:** Next.js 14 App Router, Prisma/PostgreSQL, NextAuth, TypeScript, Vitest, Playwright, pnpm.

---

### Task 1: Capture the merge baseline

**Files:**
- Read: `apps/web/src/lib/admin/authorization.ts`, `apps/web/src/lib/admin/permissions.ts`, `apps/web/src/lib/admin/audit.ts`
- Read: `apps/web/src/app/admin/**`, `apps/web/src/app/api/admin/v1/**`, `apps/web/prisma/schema.prisma`

- [ ] Fetch `origin/master`, record `git status`, and verify `test-results/` remains untracked and untouched.
- [ ] Inspect every conflict with `git merge-tree` and map each branch-only behavior to an upstream equivalent before editing.

### Task 2: Merge upstream admin security and console

**Files:**
- Modify: all files reported by `git merge-tree` as conflicts, including `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/admin/users/page.tsx`, `apps/web/src/components/pages/ObservabilityPage.tsx`, and admin observability/user routes/tests.
- Add or retain: upstream `apps/web/src/components/admin/**` and `apps/web/src/app/admin/**` pages.

- [ ] Run `git merge --no-commit origin/master`.
- [ ] Resolve admin shell, overview, users, and observability conflicts by retaining upstream DB-backed membership, permission checks, MFA/session-version validation, masked DTOs, and append-only audit behavior.
- [ ] Keep the upstream `404` behavior for the retired `/api/admin/observability` route; use `/api/admin/v1/observability` for the live console.
- [ ] Preserve compatible Gmail OAuth state/return-url hardening from this branch only where it does not weaken upstream validation.

### Task 3: Reconnect candidate settings to upstream RBAC

**Files:**
- Modify: `apps/web/src/lib/admin/permissions.ts`
- Modify: `apps/web/src/app/api/admin/v1/users/[id]/settings/route.ts`
- Modify: `apps/web/src/lib/admin/settings-access.ts`
- Modify: `apps/web/src/components/admin/AdminUserDetailPage.tsx` (or the upstream user-detail component selected by the merge)
- Test: corresponding settings route/access/component tests

- [ ] Add a dedicated `users.update_preferences` permission to the shared permission registry and grant it only to `super_admin` initially; `users.read` remains sufficient for GET.
- [ ] Replace any `ADMIN_EMAILS`/`ADMIN_USER_IDS` or `requireAuth` authorization in the settings route with `requireAdmin('users.read'|'users.update_preferences')`, `isAdminResponse`, and `writeAdminAudit`.
- [ ] Keep explicit Prisma selects and the existing allow-listed notification/privacy fields; never return or accept API keys, OAuth tokens, resumes, persona content, or mailbox data.
- [ ] Add a user-detail settings panel that loads masked settings, handles PATCH errors, and reports the saved state without exposing secrets.
- [ ] Test unauthenticated (401), unauthorized (403), allowed GET, allowed PATCH, invalid field rejection, missing-user (404), and audit writes.

### Task 4: Align platform and billing controls

**Files:**
- Modify: `apps/web/src/app/api/admin/v1/platform/route.ts` (if branch version survives the merge)
- Modify: `apps/web/src/lib/admin/pricing-access.ts`
- Modify: `apps/web/src/app/api/admin/v1/plans/route.ts`
- Modify: upstream admin platform/pricing pages and their tests as needed

- [ ] Protect read-only platform integration status with the upstream platform/observability permission and no-store headers.
- [ ] Protect plan reads with `billing.read` and plan mutations with `billing.update`; record before/after audit metadata.
- [ ] Keep platform credentials server-side and return only provider, configured, and connectivity status; never return key material.
- [ ] Update tests to assert RBAC permission names, response masking, and no legacy environment bypass.

### Task 5: Verify the merged application end to end

**Files:**
- Modify: affected tests, `.env.example`, seed/docs/PR text only where required by the merged contract.

- [ ] Run focused admin/settings tests, then full web, worker, shared, and extension test suites.
- [ ] Run type checks for all packages and production builds for web, worker, and extension.
- [ ] Run Playwright E2E and a production-browser smoke pass covering admin redirect, seeded admin membership, overview/platform/users/detail settings, plan controls, all Settings tabs, API-key fallback, and Gmail OAuth return validation.
- [ ] Check Prisma migration status and run the documented role seed against the validation database; do not use an environment allow-list as a substitute.
- [ ] Run `git diff --check` and a high-confidence secret scan; inspect the final diff for unrelated changes.

### Task 6: Commit and hand off for merge

- [ ] Commit the conflict resolution and verification-related code with a scoped message.
- [ ] Push the feature branch to `origin`.
- [ ] Confirm the PR has no merge conflicts and required checks are green; leave the PR draft/open for explicit merge approval.
- [ ] Report commit hash, push result, test evidence, and any residual external prerequisites (database migration/seed or provider credentials).

---

## Self-review

- Spec coverage: upstream RBAC, admin navigation, user settings management, platform status, billing, OAuth hardening, and cross-column verification each have a task above.
- Placeholder scan: no TODO/TBD or unspecified “handle appropriately” steps are used; each implementation boundary and verification command is named.
- Type consistency: settings routes use the existing `AdminActor`, `Permission`, masked DTO, and `writeAdminAudit` interfaces from upstream.
