# Settings Role AI Precedence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure feature-level AI settings remain effective for cover-letter generation and application audits when the user's Writer or Auditor role is still the keyless platform default.

**Architecture:** `prepareAiRoute` stays the sole resolver for the user's feature setting, API key, and platform fallback. Each route retains the role's custom system prompt, but delegates model selection to the existing pure `roleAiConfig` helper so only an explicit enabled role override may replace the feature-level configuration.

**Tech Stack:** Next.js 14 App Router, TypeScript, Vitest, Prisma mocks.

---

### Task 1: Capture the feature-setting regression in the cover-letter routes

**Files:**
- Modify: `apps/web/src/__tests__/api/ai-cover-letter.test.ts`
- Modify: `apps/web/src/app/api/jobs/[id]/cover-letters/generate/route.test.ts`

- [x] **Step 1: Add failing tests for default Writer roles**

In both route tests, make `prepareAiRoute` return an enabled user configuration and make `agentRole.findFirst` return the enabled, keyless MiniMax M3 Writer default. Assert the first `modelChat` configuration retains the setting rather than reverting to MiniMax:

```ts
const settingsCfg = { provider: 'openai', model: 'gpt-4o', apiKey: 'user-openai-key' }
mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: settingsCfg })
mocks.agentRoleFindFirst.mockResolvedValue({
  enabled: true, provider: 'minimax', model: 'MiniMax-M3', apiKey: null,
  systemPrompt: 'Custom writer prompt',
})

expect(mocks.modelChat.mock.calls[0][1]).toMatchObject(settingsCfg)
```

- [x] **Step 2: Run both focused tests and verify red**

Run:

```powershell
pnpm --filter @jobcopilot/web test -- src/__tests__/api/ai-cover-letter.test.ts
pnpm --filter @jobcopilot/web test -- src/app/api/jobs/[id]/cover-letters/generate/route.test.ts
```

Expected: each new test fails because the route passes the keyless Writer role's MiniMax M3 configuration to `modelChat`.

### Task 2: Capture the feature-setting regression in the audit route

**Files:**
- Modify: `apps/web/src/app/api/jobs/[id]/audit-application/route.test.ts`

- [x] **Step 1: Replace the old fallback-only assertion with a failing feature-setting test**

Configure `prepareAiRoute` with a user-owned OpenAI setting and return an enabled, keyless MiniMax M3 Auditor role. Assert that `modelChat` receives the configured OpenAI provider, model, and key:

```ts
mocks.agentRoleFindFirst.mockResolvedValue({
  enabled: true, provider: 'minimax', model: 'MiniMax-M3', apiKey: null,
  systemPrompt: 'Auditor',
})

expect(mocks.modelChat).toHaveBeenCalledWith(
  expect.anything(),
  expect.objectContaining({ provider: 'openai', model: 'gpt-4o', apiKey: 'user-openai-key' }),
  2048,
)
```

- [x] **Step 2: Run the focused audit test and verify red**

Run:

```powershell
pnpm --filter @jobcopilot/web test -- src/app/api/jobs/[id]/audit-application/route.test.ts
```

Expected: the new test fails because the route's direct `resolveConfig` check treats the platform default's resolved service key as a user role override.

### Task 3: Apply the shared precedence rule

**Files:**
- Modify: `apps/web/src/app/api/ai/cover-letter/route.ts`
- Modify: `apps/web/src/app/api/jobs/[id]/cover-letters/generate/route.ts`
- Modify: `apps/web/src/app/api/jobs/[id]/audit-application/route.ts`

- [x] **Step 1: Import the existing role resolver**

Add this import to each route:

```ts
import { roleAiConfig } from '@/lib/agent/role-config'
```

- [x] **Step 2: Preserve the `enabled` field in each role select**

Change each `agentRole.findFirst` select to include `enabled: true`, ensuring a disabled custom role cannot override Settings.

- [x] **Step 3: Resolve route configuration through the helper**

For cover letters, replace the direct Writer object construction with:

```ts
const selectedCfg = roleAiConfig('writer', writerRole, prep.cfg)
const cfg = withMiniMaxThinking(selectedCfg, 'disabled')
```

For auditing, replace `configuredAuditor` plus `resolveConfig` with:

```ts
const cfg = roleAiConfig('auditor', auditorRole, prep.cfg)
```

Do not change fallback ordering, prompts, persistence, or response contracts.

- [x] **Step 4: Run the three focused tests and verify green**

Run:

```powershell
pnpm --filter @jobcopilot/web test -- src/__tests__/api/ai-cover-letter.test.ts
pnpm --filter @jobcopilot/web test -- src/app/api/jobs/[id]/cover-letters/generate/route.test.ts
pnpm --filter @jobcopilot/web test -- src/app/api/jobs/[id]/audit-application/route.test.ts
```

Expected: all tests pass, and default roles preserve the feature-level setting while explicit role overrides retain their existing behavior.

### Task 4: Validate the settings/admin integration change set

**Files:**
- Verify: `apps/web/src/app/api/admin/v1/broadcasts/[id]/preview/route.ts`
- Verify: `apps/web/src/app/api/admin/v1/broadcasts/[id]/preview/route.test.ts`
- Verify: `apps/web/src/lib/admin/authorization.ts`
- Verify: `apps/web/src/lib/admin/authorization.test.ts`
- Verify: `apps/web/src/app/api/ai/cover-letter/route.ts`
- Verify: `apps/web/src/app/api/jobs/[id]/cover-letters/generate/route.ts`
- Verify: `apps/web/src/app/api/jobs/[id]/audit-application/route.ts`

- [x] **Step 1: Run focused security and model-precedence tests**

Run:

```powershell
pnpm --filter @jobcopilot/web test -- src/lib/admin/authorization.test.ts src/app/api/admin/v1/broadcasts/[id]/preview/route.test.ts src/__tests__/api/ai-cover-letter.test.ts src/app/api/jobs/[id]/cover-letters/generate/route.test.ts src/app/api/jobs/[id]/audit-application/route.test.ts
```

Expected: all selected tests pass; an invalid cross-origin admin write is rejected before authentication, auditing, idempotency, or the route mutation.

- [x] **Step 2: Run repository acceptance checks**

Run:

```powershell
pnpm --filter @jobcopilot/web test -- --maxWorkers=1
pnpm --filter @jobcopilot/worker test
pnpm --filter @jobcopilot/shared test
pnpm --filter @jobcopilot/extension test
pnpm typecheck:all
pnpm exec turbo build --force
git diff --check
```

Expected: each command exits successfully. Report any pre-existing warning separately from failures.

- [ ] **Step 3: Commit and push the scoped follow-up**

Run:

```powershell
git add apps/web/src/app/api/admin/v1/broadcasts/[id]/preview/route.ts apps/web/src/app/api/admin/v1/broadcasts/[id]/preview/route.test.ts apps/web/src/lib/admin/authorization.ts apps/web/src/lib/admin/authorization.test.ts apps/web/src/app/api/ai/cover-letter/route.ts apps/web/src/__tests__/api/ai-cover-letter.test.ts apps/web/src/app/api/jobs/[id]/cover-letters/generate/route.ts apps/web/src/app/api/jobs/[id]/cover-letters/generate/route.test.ts apps/web/src/app/api/jobs/[id]/audit-application/route.ts apps/web/src/app/api/jobs/[id]/audit-application/route.test.ts docs/superpowers/plans/2026-08-09-settings-role-ai-precedence.md
git commit -m "fix(settings): honor feature AI model defaults"
git push origin HEAD:feat/settings-admin-wiring
```

Expected: the Draft PR branch receives the security and Settings integration fixes without production deployment.
