# Admin Security Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the server-enforced internal admin identity, dynamic role/permission matrix, session revocation, safe DTOs, and audited access-management UI that the remaining admin workflows will use.

**Architecture:** Keep candidate authorization (`requireAuth` plus `userId` ownership predicates) separate from admin authorization. Store administrator membership and editable role matrices in Prisma, but validate every permission key against an allow-listed catalogue in code. Route handlers call `requireAdmin`, CSRF/idempotency guards, explicit DTO builders, and a transactional append-only audit writer before returning data or mutating state.

**Tech Stack:** Next.js App Router route handlers and React pages, NextAuth v5 JWT sessions, Prisma/PostgreSQL, TypeScript, Vitest, existing `db`, `safeAuth`, and `api-helpers` utilities.

---

## File Map

### New security libraries

- `apps/web/src/lib/admin/permissions.ts`: permission union, domain metadata, seeded role definitions, and matrix validation.
- `apps/web/src/lib/admin/permissions.test.ts`: catalogue and role validation tests.
- `apps/web/src/lib/admin/authorization.ts`: active-membership lookup, permission check, session-version check, and actor DTO.
- `apps/web/src/lib/admin/authorization.test.ts`: 401/403, suspended/revoked membership, stale session, and allowed actor tests.
- `apps/web/src/lib/admin/csrf.ts`: same-origin validation for admin mutations.
- `apps/web/src/lib/admin/csrf.test.ts`: origin/method/header tests.
- `apps/web/src/lib/admin/idempotency.ts`: request-body hashing and persisted key/response replay.
- `apps/web/src/lib/admin/idempotency.test.ts`: duplicate key, payload mismatch, and independent actor tests.
- `apps/web/src/lib/admin/audit.ts`: safe append-only audit writer and non-sensitive snapshot filtering.
- `apps/web/src/lib/admin/audit.test.ts`: successful/denied audit and forbidden-field filtering tests.
- `apps/web/src/lib/admin/dto.ts`: explicit masked user/member/role DTOs and PII masking.
- `apps/web/src/lib/admin/dto.test.ts`: forbidden-field regression tests.

### Database and seed

- `apps/web/prisma/schema.prisma`: admin enums/models, `User.adminMembership`, and idempotency relation-free table.
- `apps/web/prisma/migrations/20260806190000_add_admin_security_foundation/migration.sql`: generated migration for the schema additions.
- `apps/web/prisma/seed-admin.ts`: controlled role seed requiring `INITIAL_SUPER_ADMIN_EMAIL` in non-development environments.
- `apps/web/prisma/seed-admin.test.ts`: seed validation and duplicate-super-admin refusal tests.

### Authentication and APIs

- `apps/web/src/lib/auth.ts`: add the admin membership session-version claim at sign-in without exposing role details to candidate UI.
- `apps/web/src/types/next-auth.d.ts`: type the internal session claim used by `requireAdmin`.
- `apps/web/src/app/api/admin/v1/access/permissions/route.ts`: allow-listed permission catalogue read endpoint.
- `apps/web/src/app/api/admin/v1/access/roles/route.ts`: role list/create endpoint.
- `apps/web/src/app/api/admin/v1/access/roles/[id]/route.ts`: role update endpoint.
- `apps/web/src/app/api/admin/v1/access/members/route.ts`: masked member list endpoint.
- `apps/web/src/app/api/admin/v1/access/members/[id]/route.ts`: membership role/status update endpoint.
- `apps/web/src/app/api/admin/v1/access/members/[id]/revoke-sessions/route.ts`: membership session-version increment endpoint.
- Each route receives a `.test.ts` sibling with mocked `db`, `safeAuth`, and request headers; no live database calls.

### Admin UI

- `apps/web/src/components/admin/AdminShell.tsx`: separate navigation shell with permission-aware links and sign-out.
- `apps/web/src/components/admin/AccessPage.tsx`: role-first editor plus read-only matrix view and member table.
- `apps/web/src/app/admin/layout.tsx`: admin route layout and error boundary.
- `apps/web/src/app/admin/page.tsx`: foundation overview with access/security status.
- `apps/web/src/app/admin/access/page.tsx`: access-management page route.

---

### Task 1: Add the Prisma security schema

**Files:** `apps/web/prisma/schema.prisma`, `apps/web/prisma/migrations/20260806190000_add_admin_security_foundation/migration.sql`

- [ ] **Step 1: Write a schema smoke test** that runs `prisma validate` and asserts the generated client contains `AdminRole`, `AdminMembership`, `AdminAuditLog`, and `AdminIdempotencyKey` delegates.
- [ ] **Step 2: Run the smoke test before the schema edit** and record the expected missing-model failure.
- [ ] **Step 3: Add the four admin models and enums** from the approved design, add `User.adminMembership`, and keep all candidate ownership relations unchanged. Use `onDelete: Restrict` for admin membership references.
- [ ] **Step 4: Generate a migration** with `pnpm --filter web exec prisma migrate dev --create-only --name add_admin_security_foundation` in a database-capable environment. If migration dev cannot connect, write the equivalent SQL with `CREATE TYPE`, `CREATE TABLE`, indexes, and foreign keys, then run `pnpm --filter web exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma` only as a syntax check.
- [ ] **Step 5: Run `pnpm --filter web exec prisma validate` and `pnpm --filter web exec prisma generate`**; expected output is successful validation and generated client.
- [ ] **Step 6: Commit** with `git add apps/web/prisma && git commit -m "feat(admin): add security foundation schema"`.

### Task 2: Define and test the permission catalogue

**Files:** `apps/web/src/lib/admin/permissions.ts`, `apps/web/src/lib/admin/permissions.test.ts`

- [ ] **Step 1: Add failing tests** for the complete catalogue used by this release: `admin_members.read`, `admin_members.manage`, `admin_roles.manage`, `sessions.revoke`, `audit.read`, `users.read`, `users.suspend`, `users.restore`, `billing.read`, `billing.update`, `ai_budget.read`, `broadcasts.create`, `broadcasts.preview`, `broadcasts.approve`, `broadcasts.publish`, `support_cases.read`, `support_cases.assign`, `support_cases.reply`, `support_cases.note`, `support_cases.resolve`, and `observability.read`.
- [ ] **Step 2: Implement `Permission`, `PERMISSIONS`, `permissionMeta`, and `ROLE_SEEDS`**. Seed role permissions explicitly; do not implement implicit role inheritance.
- [ ] **Step 3: Implement `validatePermissionList(values: unknown)`** to trim, deduplicate, reject unknown keys, and require at least one permission for non-system custom roles.
- [ ] **Step 4: Implement `canEditRole(actor, target)`** so only `admin_roles.manage` can edit, a role cannot grant a permission the actor does not hold, and the last active `super_admin` cannot be removed or demoted.
- [ ] **Step 5: Run `pnpm --filter web test -- src/lib/admin/permissions.test.ts`; expected: all catalogue and guard tests pass.**
- [ ] **Step 6: Commit** with `git add apps/web/src/lib/admin/permissions* && git commit -m "feat(admin): define dynamic permission catalogue"`.

### Task 3: Implement CSRF and persisted idempotency guards

**Files:** `apps/web/src/lib/admin/csrf.ts`, `csrf.test.ts`, `idempotency.ts`, `idempotency.test.ts`

- [ ] **Step 1: Write failing tests** for rejecting mutating requests whose `Origin` is not the configured canonical origin, accepting same-origin requests, requiring `Idempotency-Key`, replaying the stored response for the same actor/key/hash, returning `409` for the same key with a different hash, and allowing the same key for different actors.
- [ ] **Step 2: Implement `assertAdminWriteRequest(req)`** with `POST`, `PATCH`, and `DELETE` handling, canonical-origin comparison from `AUTH_CANONICAL_URL`, and no CSRF requirement for safe `GET` requests.
- [ ] **Step 3: Implement `withIdempotency(tx, actorUserId, key, action, body, operation)`**. Hash stable JSON, insert a reservation in a transaction, execute the operation once, store status/body, and return the stored response on a duplicate. Reject a hash mismatch.
- [ ] **Step 4: Run the focused Vitest files; expected: duplicate requests never execute the operation twice.**
- [ ] **Step 5: Commit** with `git add apps/web/src/lib/admin/csrf* apps/web/src/lib/admin/idempotency* && git commit -m "feat(admin): enforce csrf and idempotent writes"`.

### Task 4: Implement safe audit and DTO helpers

**Files:** `apps/web/src/lib/admin/audit.ts`, `audit.test.ts`, `dto.ts`, `dto.test.ts`

- [ ] **Step 1: Add failing tests** proving snapshots omit password, API key, OAuth token, resume content, persona values, Gmail content, and arbitrary unknown fields; prove controlled email/name values are masked consistently.
- [ ] **Step 2: Implement `safeSnapshot(input, allowList)`** as an allow-list builder that drops all other keys recursively and truncates long free-text reasons without accepting content fields.
- [ ] **Step 3: Implement `maskEmail`, `maskName`, `toAdminMemberDto`, and `toAdminRoleDto`** from explicit input shapes rather than Prisma objects.
- [ ] **Step 4: Implement `writeAdminAudit(tx, event)`** with request ID, actor, action, target, reason, outcome, hashed request metadata, and safe before/after snapshots. Never log the original input on failure.
- [ ] **Step 5: Run focused tests and inspect the serialized JSON for forbidden keys; expected: forbidden keys are absent, not merely blank.**
- [ ] **Step 6: Commit** with `git add apps/web/src/lib/admin/audit* apps/web/src/lib/admin/dto* && git commit -m "feat(admin): add safe dto and audit primitives"`.

### Task 5: Add server-side admin authorization and JWT versioning

**Files:** `apps/web/src/lib/admin/authorization.ts`, `authorization.test.ts`, `apps/web/src/lib/auth.ts`, `apps/web/src/types/next-auth.d.ts`

- [ ] **Step 1: Write failing tests** for no session (`401`), missing membership (`403`), suspended/revoked membership (`403`), stale `adminSessionVersion` (`403`), missing permission (`403`), and an active allowed actor containing only safe fields.
- [ ] **Step 2: Extend the NextAuth JWT callback** to set `adminSessionVersion` only when an admin membership exists at sign-in; extend the session type without making it part of candidate-facing data APIs.
- [ ] **Step 3: Implement `requireAdmin(permission, req?)`**: call `safeAuth`, select membership plus role permissions explicitly, compare status and session version, verify the requested allow-listed permission, and return an immutable actor object. Denials call the audit writer with `outcome: denied` but no candidate content.
- [ ] **Step 4: Run the authorization tests; expected: every forged role/session case is denied.**
- [ ] **Step 5: Commit** with `git add apps/web/src/lib/admin/authorization* apps/web/src/lib/auth.ts apps/web/src/types/next-auth.d.ts && git commit -m "feat(admin): enforce membership authorization"`.

### Task 6: Seed roles and initial access safely

**Files:** `apps/web/prisma/seed-admin.ts`, `seed-admin.test.ts`

- [ ] **Step 1: Add failing tests** for missing initial email, development seed, production refusal when a super-admin already exists, idempotent rerun for the same user, and refusal to exceed two standing super-admin memberships.
- [ ] **Step 2: Implement `seedAdminRoles({ initialEmail, environment })`** with the role definitions from `ROLE_SEEDS`, an exact normalized-email lookup, and an explicit production guard.
- [ ] **Step 3: Ensure the script never prints or selects secrets** and reports only role/member counts.
- [ ] **Step 4: Run `pnpm --filter web test -- prisma/seed-admin.test.ts`; expected: all safety guards pass.**
- [ ] **Step 5: Commit** with `git add apps/web/prisma/seed-admin* && git commit -m "feat(admin): add controlled access seed"`.

### Task 7: Add versioned access-management API routes

**Files:** `apps/web/src/app/api/admin/v1/access/**` and route test siblings

- [ ] **Step 1: Add route tests first** for permission catalogue read, role list/create/update, member list/update, and session revoke. Mock `requireAdmin`, Prisma delegates, CSRF, idempotency, and audit; assert `Cache-Control: no-store` and `x-request-id` on responses.
- [ ] **Step 2: Implement `GET /access/permissions`** with `admin_members.read` and a static catalogue response.
- [ ] **Step 3: Implement role routes** with `admin_roles.manage`, validated names/keys/permissions, optimistic `version`, self-escalation prevention, idempotency, and audit snapshots.
- [ ] **Step 4: Implement member routes** with `admin_members.read/manage`, explicit masked user select, self-demotion and last-super-admin guards, status transitions, and audit.
- [ ] **Step 5: Implement `POST /revoke-sessions`** with `sessions.revoke`, atomic `sessionVersion` increment, idempotency, and audit.
- [ ] **Step 6: Run all access route tests; expected: 401/403/success, CSRF, replay, version conflict, and no-secret assertions pass.**
- [ ] **Step 7: Commit** with `git add apps/web/src/app/api/admin/v1/access && git commit -m "feat(admin): add access management api"`.

### Task 8: Build the isolated AdminShell and access page

**Files:** `apps/web/src/components/admin/AdminShell.tsx`, `AccessPage.tsx`, `apps/web/src/app/admin/layout.tsx`, `page.tsx`, `access/page.tsx`

- [ ] **Step 1: Add a render test or route smoke test** proving candidate pages do not render the admin shell and an unauthorized admin response redirects/returns an access-denied state.
- [ ] **Step 2: Implement `AdminShell`** with permission-aware navigation, visible signed-in admin identity, no candidate data preload, keyboard-visible focus, and responsive collapse.
- [ ] **Step 3: Implement `AccessPage`** with role-first editing, grouped permission checkboxes, member status/role controls, revoke-sessions confirmation, dirty-state guard, and a read-only matrix tab.
- [ ] **Step 4: Wire forms to the versioned access APIs** with idempotency keys per submit, reason fields for writes, optimistic version errors, and inline audit-safe error messages.
- [ ] **Step 5: Run the web typecheck and a local Playwright smoke at desktop and 360px widths; expected: no clipping, no forbidden data in network responses, and all controls keyboard reachable.**
- [ ] **Step 6: Commit** with `git add apps/web/src/components/admin apps/web/src/app/admin && git commit -m "feat(admin): add access management console"`.

### Task 9: Security regression and handoff

**Files:** `apps/web/src/__tests__/api/admin-security-regression.test.ts`, docs if needed

- [ ] **Step 1: Add integration tests** that forge candidate plan values, guessed nested IDs, stale sessions, unknown permission keys, and forbidden DTO fields; assert every path is denied or redacted.
- [ ] **Step 2: Run `pnpm --filter web test`, `pnpm --filter web tsc --noEmit --skipLibCheck`, and `git diff --check`; record exact counts.**
- [ ] **Step 3: Run `pnpm --filter web exec prisma validate` and verify the migration applies in the configured database environment.**
- [ ] **Step 4: Review changed files against the plan and confirm no `UserApiKeys`, passwords, OAuth tokens, resume bodies, or Gmail fields are selected.**
- [ ] **Step 5: Commit any final test-only/doc-only changes, push the branch to `origin`, and prepare the PR body with the required AC and goal-alignment tables.**

## Plan self-review

- Spec coverage: the first plan covers the entire security foundation slice; users/plans, AI, broadcasts, and support are explicitly separate follow-up plans and are not silently folded into this implementation.
- Placeholder scan: no `TBD`, `TODO`, or unspecified “handle errors” steps remain. Every route, helper, test family, command, and commit boundary is named.
- Type consistency: `Permission`, `AdminMembership`, `AdminRole`, `AdminAuditLog`, and `AdminIdempotencyKey` names match the design specification and Prisma models.
- Security check: all writes pass CSRF, idempotency, reason, optimistic version, and audit requirements; admin DTOs are allow-listed and masked.
