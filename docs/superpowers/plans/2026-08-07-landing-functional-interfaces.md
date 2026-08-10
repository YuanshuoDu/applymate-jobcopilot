# Landing Page Functional Interfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the landing page's fake contact behavior and dead links, and make landing/settings pricing read from an administrator-managed plan catalogue.

**Architecture:** A Prisma `PlanCatalogue` table stores the public SaaS plan configuration. A pure shared module defines the safe DTO and seed defaults; a server helper reads and normalizes database rows. `/api/plans` exposes active plans publicly, `/api/admin/v1/plans` provides guarded CRUD-style updates, and both the landing server payload and signed-in billing UI consume the same helper/DTO. The contact route uses the existing Resend provider without persisting lead content.

**Tech Stack:** Next.js App Router, React 19, Prisma/PostgreSQL, NextRequest/NextResponse, Vitest, existing `useApi`/`apiMutate` hooks, Resend HTTP API.

---

### Task 1: Shared plan catalogue and database storage

**Files:**
- Create: `apps/web/src/lib/plan-catalogue-shared.ts`
- Create: `apps/web/src/lib/plan-catalogue.ts`
- Modify: `apps/web/prisma/schema.prisma`
- Create: `apps/web/prisma/migrations/20260807100000_add_plan_catalogue/migration.sql`
- Modify: `apps/web/prisma/seed.ts`
- Test: `apps/web/src/lib/plan-catalogue.test.ts`

- [ ] **Step 1: Write the failing catalogue tests**

Cover the public DTO shape, the default `free`/`pro`/`enterprise` values (`0/1200/2900` EUR cents), stable ordering, and normalization of invalid stored feature JSON to an empty list.

```ts
it('exposes the settings pricing baseline as defaults', () => {
  expect(DEFAULT_PLAN_CATALOGUE.map(plan => [plan.key, plan.priceMinor])).toEqual([
    ['free', 0], ['pro', 1200], ['enterprise', 2900],
  ])
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run `pnpm --filter web test -- src/lib/plan-catalogue.test.ts`; it must fail because the shared module does not exist yet.

- [ ] **Step 3: Implement the pure shared types and server normalizer**

Define `PlanKey`, `BillingInterval`, `PlanCatalogueInput`, `PublicPlan`, `DEFAULT_PLAN_CATALOGUE`, `formatPlanPrice`, and `normalizePlanRow`. Keep the shared file free of Prisma imports so client components can use the types. In `plan-catalogue.ts`, add `getPublicPlans()` and `getAdminPlans()` using `db.planCatalogue`; return defaults only when the public read has no rows, and preserve database errors for admin writes.

- [ ] **Step 4: Add the Prisma model, migration, and idempotent seed**

Add `PlanCatalogue` with a unique `plan Plan`, `priceMinor Int`, `currency`, `interval BillingInterval`, `description`, `features Json`, optional `badge`, `cta`, `trialDays`, `active`, `sortOrder`, timestamps, and `@@map("plan_catalogue")`. The SQL migration must create the enum/table and insert the three defaults. Seed with `upsert` and an empty update object so admin-edited values survive future seeds.

- [ ] **Step 5: Run the focused tests and type check**

Run `pnpm --filter web test -- src/lib/plan-catalogue.test.ts` and `pnpm --filter web exec prisma generate && pnpm --filter web exec tsc --noEmit --skipLibCheck`; both must pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/plan-catalogue-shared.ts apps/web/src/lib/plan-catalogue.ts apps/web/src/lib/plan-catalogue.test.ts apps/web/prisma/schema.prisma apps/web/prisma/seed.ts apps/web/prisma/migrations/20260807100000_add_plan_catalogue/migration.sql
git commit -m "feat(web): add managed plan catalogue"
```

### Task 2: Public and administrator plan APIs

**Files:**
- Create: `apps/web/src/app/api/plans/route.ts`
- Create: `apps/web/src/app/api/plans/route.test.ts`
- Create: `apps/web/src/lib/admin/pricing-access.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/route.ts`
- Create: `apps/web/src/app/api/admin/v1/plans/route.test.ts`

- [ ] **Step 1: Write failing route tests**

Mock Prisma and auth. Verify `GET /api/plans` returns active public fields only, admin access is denied without an allow-listed identity, valid PATCH updates the catalogue, malformed price/features are rejected, and disabling the Free plan returns `400`.

- [ ] **Step 2: Implement the public route**

Return `{ plans: getPublicPlans() }` with `Cache-Control: no-store` so admin edits appear immediately. Do not include database ids, timestamps, or admin-only fields.

- [ ] **Step 3: Implement the pricing admin guard and route**

Use `requireAuth`, load the actor email, and allow only `ADMIN_USER_IDS` or `ADMIN_EMAILS` values. `GET` returns normalized editable plans. `PATCH` validates all supplied plan records, rejects unknown keys, bounds copy/features, enforces non-negative prices and at least one active Free plan, upserts all records in a transaction, and returns the updated catalogue. Never return secrets or raw Prisma rows.

- [ ] **Step 4: Run route tests**

Run `pnpm --filter web test -- src/app/api/plans/route.test.ts src/app/api/admin/v1/plans/route.test.ts` and confirm all cases pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/plans apps/web/src/app/api/admin/v1/plans apps/web/src/lib/admin/pricing-access.ts
git commit -m "feat(web): expose managed pricing APIs"
```

### Task 3: Real contact submission endpoint

**Files:**
- Create: `apps/web/src/app/api/contact/route.ts`
- Create: `apps/web/src/app/api/contact/route.test.ts`
- Create: `apps/web/src/lib/contact-message.ts`

- [ ] **Step 1: Write failing route tests**

Mock global `fetch` and cover invalid JSON, missing/invalid fields, missing Resend configuration (`503`), successful provider response (`201`), and provider failure (`503`). Assert the request body contains the submitted values but route responses do not expose provider details.

- [ ] **Step 2: Implement validation and email composition**

Normalize and bound `name` to 120 characters, `email` to 320, and `message` to 4000. Reject empty fields and invalid email format. Encode HTML values before interpolation. Resolve recipient from `CONTACT_TO_EMAIL`, `NEXT_PUBLIC_SUPPORT_EMAIL`, then `hello@applymate.ai`; resolve sender from `EMAIL_FROM` and key from `RESEND_API_KEY`.

- [ ] **Step 3: Implement the POST route**

Return `400` for validation errors, `503` for unavailable/failing Resend, and `201` with `{ ok: true }` after a successful `https://api.resend.com/emails` request. Do not log submitted content.

- [ ] **Step 4: Run tests and commit**

Run `pnpm --filter web test -- src/app/api/contact/route.test.ts`, then commit with `git add apps/web/src/app/api/contact apps/web/src/lib/contact-message.ts && git commit -m "feat(web): send landing contact messages"`.

### Task 4: Wire the landing page to real data and links

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/components/landing/LandingPage.tsx`
- Create: `apps/web/src/components/landing/LandingPage.test.tsx`
- Create: `apps/web/src/components/landing/landing-links.ts`

- [ ] **Step 1: Write failing component tests**

Render the page with a supplied plan payload and assert managed prices/features appear, `fetch('/api/contact')` is called on submit, successful and failed states are visible, entered values remain after failure, and no rendered anchor has `href="#"`.

- [ ] **Step 2: Pass the SSR-safe public plans into the landing page**

In `Home`, load `getPublicPlans()` only for the unauthenticated branch and pass `plans` to `LandingPage`. Replace the hardcoded pricing array with a UI mapping from `PublicPlan`; keep visual card styling and CTA routing unchanged.

- [ ] **Step 3: Implement contact state handling**

Replace the delay-only `handleContact` with a JSON POST. Add `contactError`, reset it before retry, show a clear error below the form, disable while submitting, and only clear/show success after a `201` response.

- [ ] **Step 4: Replace placeholder footer links**

Create a typed link map for section anchors, `/login`, `/register`, the repository URL, and subject-specific `mailto:` support/legal/company links. Render external links with `target="_blank"` and `rel="noreferrer"`; keep page anchors same-tab.

- [ ] **Step 5: Run component tests and commit**

Run `pnpm --filter web test -- src/components/landing/LandingPage.test.tsx`; commit the landing changes with `git add apps/web/src/app/page.tsx apps/web/src/components/landing && git commit -m "feat(web): connect landing page actions"`.

### Task 5: Connect settings billing and add admin plan management UI

**Files:**
- Modify: `apps/web/src/components/pages/SettingsPage.tsx`
- Create: `apps/web/src/app/admin/plans/page.tsx`
- Create: `apps/web/src/components/pages/PlanManagementPage.tsx`
- Create: `apps/web/src/components/pages/PlanManagementPage.test.tsx`
- Modify: `apps/web/src/components/pages/ObservabilityPage.tsx`

- [ ] **Step 1: Write failing UI tests**

Assert the billing view renders the same `free`, `pro`, and `enterprise` keys from `/api/plans`, and the admin page renders editable price/name/feature fields, submits a PATCH, and shows an error when the admin API denies access.

- [ ] **Step 2: Replace static settings prices**

Use `useApi('/api/plans')` in the billing tab, display a loading state while the response is pending, and derive current-plan comparison from the stable plan key. Keep existing billing support actions because checkout is not implemented.

- [ ] **Step 3: Implement the admin Plans screen**

Use `useApi('/api/admin/v1/plans')` and `apiMutate` to edit one plan at a time. Support fields covered by the API, preserve array ordering for features, disable Save during requests, and show the guard/provider error without losing local edits. Add a link from Observability's admin header to `/admin/plans`.

- [ ] **Step 4: Run UI tests and commit**

Run `pnpm --filter web test -- src/components/pages/PlanManagementPage.test.tsx`; commit with `git add apps/web/src/components/pages/SettingsPage.tsx apps/web/src/app/admin/plans apps/web/src/components/pages/PlanManagementPage* apps/web/src/components/pages/ObservabilityPage.tsx && git commit -m "feat(web): connect billing and admin plan controls"`.

### Task 6: Full verification and browser smoke test

**Files:**
- No new files.

- [ ] **Step 1: Run focused and full web tests**

Run `pnpm --filter web test -- src/lib/plan-catalogue.test.ts src/app/api/plans/route.test.ts src/app/api/admin/v1/plans/route.test.ts src/app/api/contact/route.test.ts src/components/landing/LandingPage.test.tsx src/components/pages/PlanManagementPage.test.tsx`, then `pnpm --filter web test`.

- [ ] **Step 2: Run type check**

Run `pnpm --filter web exec prisma generate && pnpm --filter web exec tsc --noEmit --skipLibCheck`; no new errors are acceptable.

- [ ] **Step 3: Run local browser smoke test**

Start `pnpm --filter web exec next dev -p 3002`, open an unauthenticated local host, verify managed pricing renders, submit the contact form with Resend mocked or unconfigured and verify the visible error/success state, and click every footer link to confirm none navigates to `#`.

- [ ] **Step 4: Review diff and commit verification notes**

Run `git status --short`, `git diff --check`, and record the test counts and any environment-only Resend/database limitation in the final handoff.
