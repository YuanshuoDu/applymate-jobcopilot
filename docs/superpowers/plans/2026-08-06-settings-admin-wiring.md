# Settings and Admin Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fully connect candidate Settings controls to durable APIs and expose the same safe settings through an authorized admin management surface.

**Architecture:** Keep candidate authentication and ownership in `/api/me`; centralize JSON preference defaults/merging in a pure helper. Add a small, deny-by-default admin authorization/DTO layer and versioned user-settings route without exposing secrets. The Settings UI uses optimistic persistence for toggles and real download/delete/connect actions.

**Tech Stack:** Next.js 14 App Router, React, Prisma/PostgreSQL JSON preferences, NextAuth, TypeScript, Vitest.

---

### Task 1: Define the shared settings contract

**Files:**
- Create: `apps/web/src/lib/settings-preferences.ts`
- Test: `apps/web/src/lib/settings-preferences.test.ts`
- Modify: `apps/web/src/lib/types.ts`

- [ ] Write failing tests for defaults, top-level merge preserving `aiSettings`, and avatar validation (valid image data URL, non-image, over 2 MiB, remote URL).
- [ ] Run the focused test and observe failure because the helper does not exist.
- [ ] Implement typed preference interfaces, `DEFAULT_NOTIFICATION_PREFERENCES`, `DEFAULT_PRIVACY_PREFERENCES`, `mergeUserPreferences`, and `validateAvatarValue`.
- [ ] Run the focused test and confirm it passes.

### Task 2: Harden candidate profile APIs

**Files:**
- Modify: `apps/web/src/app/api/me/route.ts`
- Modify: `apps/web/src/app/api/me/delete/route.ts`
- Test: `apps/web/src/app/api/me/route.test.ts`
- Test: `apps/web/src/app/api/me/delete/route.test.ts`

- [ ] Add failing route tests for preference merging, invalid avatar rejection, and authenticated delete behavior.
- [ ] Implement server-side validation and merge semantics; preserve existing AI/future keys.
- [ ] Keep deletion at `/api/me/delete` and verify the confirmation remains case-insensitive.
- [ ] Run the route tests.

### Task 3: Add deny-by-default admin settings API

**Files:**
- Create: `apps/web/src/lib/admin/settings-access.ts`
- Test: `apps/web/src/lib/admin/settings-access.test.ts`
- Create: `apps/web/src/app/api/admin/v1/users/route.ts`
- Test: `apps/web/src/app/api/admin/v1/users/route.test.ts`
- Create: `apps/web/src/app/api/admin/v1/users/[id]/settings/route.ts`
- Test: `apps/web/src/app/api/admin/v1/users/[id]/settings/route.test.ts`
- Modify: `apps/web/src/app/api/admin/observability/route.ts`

- [ ] Test allow-list authorization, masked DTO redaction, bounded patch fields, and ownership lookup.
- [ ] Implement `requireSettingsAdmin`, safe user listing, and GET/PATCH settings route using explicit Prisma selects and activity audit records.
- [ ] Guard observability with the same admin check and no-store headers.
- [ ] Run focused admin tests.

### Task 4: Complete the Settings UI wiring

**Files:**
- Modify: `apps/web/src/components/pages/SettingsPage.tsx`

- [ ] Add failing behavior tests for preference state serialization/export URL where practical.
- [ ] Add avatar file input and save/error handling.
- [ ] Load and persist notification/privacy preferences with optimistic rollback.
- [ ] Download persona export and call `/api/me/delete` for account deletion.
- [ ] Handle account disconnect failures and disable unsupported providers truthfully.
- [ ] Replace fake billing success toasts with support links.
- [ ] Support all valid `?tab=` values and keep URL state synchronized.

### Task 5: Add minimal admin users/settings UI

**Files:**
- Create: `apps/web/src/components/pages/AdminUsersPage.tsx`
- Test: `apps/web/src/components/pages/AdminUsersPage.test.tsx`
- Create: `apps/web/src/app/admin/users/page.tsx`

- [ ] Render masked users and editable notification/privacy controls.
- [ ] Wire GET/PATCH with request error states and explicit admin-only messaging.
- [ ] Add route shell link from the existing admin observability surface.

### Task 6: Verify and hand off

- [ ] Run focused tests for every new helper/route.
- [ ] Run `pnpm --filter web test`.
- [ ] Run `pnpm --filter web tsc --noEmit --skipLibCheck`.
- [ ] Run `pnpm --filter web build` if environment permits.
- [ ] Run `git diff --check`, inspect changed files for secret leakage, commit, and push to `origin`.
