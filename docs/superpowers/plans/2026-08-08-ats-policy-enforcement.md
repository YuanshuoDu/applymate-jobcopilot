# ATS Policy Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make persisted admin ATS policies control discovery and unattended application behavior, with acknowledgement only after the Worker loads a committed version.

**Architecture:** Move the hard ATS policy allow-list into `@jobcopilot/shared`; Web validation and Worker enforcement consume that one source. The Worker uses a small database-backed effective-policy resolver and Redis pacing gate before every source request. Web routes commit desired state first, then request a version-checked Worker acknowledgement and conditionally mark it propagated.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, pg, BullMQ, ioredis, Express, Vitest.

---

### Task 1: Centralize hard ATS ceilings

**Files:**
- Create: `packages/shared/src/ats-policy.ts`
- Create: `packages/shared/src/ats-policy.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/web/src/lib/agent/pace/policies.ts`
- Modify: `apps/web/src/lib/admin/ats-service.ts`

- [ ] **Step 1: Write the failing shared-policy tests**

```ts
import { ATS_HARD_POLICIES, hardAtsRpsLimit, isAtsSourceKey } from './ats-policy.js'

it('keeps every supported ATS on an explicit hard ceiling', () => {
  expect(ATS_HARD_POLICIES.greenhouse.rps).toBe(5)
  expect(hardAtsRpsLimit('workday')).toBe(1)
  expect(isAtsSourceKey('unknown')).toBe(false)
})
```

- [ ] **Step 2: Run the focused test and observe the missing-module failure**

Run: `pnpm --filter @jobcopilot/shared test -- src/ats-policy.test.ts`

- [ ] **Step 3: Export the typed static allow-list**

```ts
export const ATS_HARD_POLICIES = {
  greenhouse: { host: 'boards-api.greenhouse.io', rps: 5 },
  lever: { host: 'api.lever.co', rps: 5 },
  workday: { host: 'myworkdayjobs.com', rps: 1 },
  smartrecruiters: { host: 'api.smartrecruiters.com', rps: 5 },
  personio: { host: 'jobs.personio.com', rps: 5 },
} as const

export function hardAtsRpsLimit(value: string): number | null { /* allow-list lookup */ }
```

Re-export it from `packages/shared/src/index.ts`. Change Web pacing to re-export
the shared map, preserving its `acquire` public API. Change
`hardRpsLimit` to use the shared lookup.

- [ ] **Step 4: Run focused shared and Web policy tests**

Run: `pnpm --filter @jobcopilot/shared test -- src/ats-policy.test.ts`
Run: `pnpm --filter web test -- src/lib/admin/ats-service.test.ts src/lib/agent/pace/policies.test.ts`

- [ ] **Step 5: Commit the isolated shared-ceiling change**

```powershell
git add packages/shared/src/ats-policy.ts packages/shared/src/ats-policy.test.ts packages/shared/src/index.ts apps/web/src/lib/agent/pace/policies.ts apps/web/src/lib/admin/ats-service.ts
git commit -m "refactor(policy): share ATS hard ceilings"
```

### Task 2: Add Worker effective-policy, rollout, pacing, and retry primitives

**Files:**
- Create: `apps/worker/src/admin/ats-policy.ts`
- Create: `apps/worker/src/admin/ats-policy.test.ts`

- [ ] **Step 1: Write failing tests for policy interpretation**

```ts
it('defaults missing rows to current behavior but fails closed on database errors', async () => {
  await expect(loadEffectiveAtsPolicy(poolWithoutRow, 'lever')).resolves.toMatchObject({ configured: false, discoveryAllowed: true, autoApplyAllowed: true })
  await expect(loadEffectiveAtsPolicy(failingPool, 'lever')).rejects.toThrow('ATS policy lookup failed')
})

it('blocks paused sources and deterministically honors rollout', () => {
  expect(canUseAtsSource(pausedPolicy, 'user-1', 'discovery')).toBe(false)
  expect(canUseAtsSource(tenPercentPolicy, 'user-1', 'discovery')).toBe(canUseAtsSource(tenPercentPolicy, 'user-1', 'discovery'))
})
```

- [ ] **Step 2: Run the failing focused test**

Run: `pnpm --filter @jobcopilot/worker test -- src/admin/ats-policy.test.ts`

- [ ] **Step 3: Implement a database-backed effective snapshot**

`loadEffectiveAtsPolicy(pool, sourceKey)` selects mapped
`ats_source_policies` columns. It creates a no-row fallback that preserves the
current Worker behavior, clamps `globalRpsLimit` and `perTenantRpsLimit` to
`hardAtsRpsLimit`, and returns source/version/configured metadata. The helper
exports `canUseAtsSource(policy, userId, mode)` and treats only `enabled` and
`degraded` states as enabled.

- [ ] **Step 4: Add deterministic Redis pacing and retry tests**

```ts
await acquireAtsPacing(fakeRedis, effectivePolicy, 'lever', 'user-1', fakeSleep)
expect(fakeRedis.set).toHaveBeenCalledWith('ats:pace:lever:global', '1', 'PX', 200, 'NX')

const result = await withAtsRetries(policyWithTwoRetries, operation, fakeSleep)
expect(operation).toHaveBeenCalledTimes(3)
```

- [ ] **Step 5: Implement paced slots and bounded retries**

`acquireAtsPacing` acquires both `ats:pace:<source>:global` and
`ats:pace:<source>:user:<userId>` keys with `SET ... PX ... NX`; failed slot
acquisition waits for `PTTL` before retrying. `withAtsRetries` retries only
provider operations, with exponential wait bounded by the configured policy.

- [ ] **Step 6: Run the Worker policy test**

Run: `pnpm --filter @jobcopilot/worker test -- src/admin/ats-policy.test.ts`

- [ ] **Step 7: Commit the Worker policy primitives**

```powershell
git add apps/worker/src/admin/ats-policy.ts apps/worker/src/admin/ats-policy.test.ts
git commit -m "feat(worker): enforce effective ATS policies"
```

### Task 3: Wire Scout discovery and auto-apply to effective policy

**Files:**
- Modify: `apps/worker/src/queue/scout-queue.ts`
- Create: `apps/worker/src/queue/scout-queue.test.ts`
- Modify: `apps/worker/src/queue/apply-queue.ts`
- Modify: `apps/worker/src/queue/apply-queue.test.ts` or the existing focused test file

- [ ] **Step 1: Write failing source-gate tests**

```ts
it('does not make an outbound request when a source is paused', async () => {
  await discoverSource({ sourceKey: 'greenhouse', userId: 'u1', policy: paused })
  expect(fetch).not.toHaveBeenCalled()
})

it('does not navigate an unattended task when a configured source forbids auto apply', async () => {
  await runApplyTask(taskForGreenhouse)
  expect(page.goto).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run focused tests and observe failure**

Run: `pnpm --filter @jobcopilot/worker test -- src/queue/scout-queue.test.ts src/queue/apply-queue.test.ts`

- [ ] **Step 3: Replace fixed scout pacing with policy gates**

For each Greenhouse and Lever slug, load a fresh effective policy, stop the
source when discovery is not allowed, call `acquireAtsPacing`, then wrap the
fetch in `withAtsRetries`. Keep the existing 8-second abort signal, HTML
normalization, filtering, and database insert behavior unchanged.

- [ ] **Step 4: Gate known ATS unattended application before browser use**

Resolve `detectFlow(applyUrl)` before navigation. For a known configured ATS,
load the effective policy and return the existing safe manual/task-state outcome
when auto-apply is not permitted. A missing policy row follows the existing
flow. Do not change unknown-provider behavior.

- [ ] **Step 5: Run all relevant Worker tests**

Run: `pnpm --filter @jobcopilot/worker test -- src/admin/ats-policy.test.ts src/queue/scout-queue.test.ts src/queue/apply-queue.test.ts`

- [ ] **Step 6: Commit the Worker integrations**

```powershell
git add apps/worker/src/queue/scout-queue.ts apps/worker/src/queue/scout-queue.test.ts apps/worker/src/queue/apply-queue.ts apps/worker/src/queue/apply-queue.test.ts
git commit -m "feat(worker): apply ATS controls to discovery and apply"
```

### Task 4: Make Web propagation post-commit and version-verified

**Files:**
- Create: `apps/web/src/lib/admin/ats-policy-propagation.ts`
- Create: `apps/web/src/lib/admin/ats-policy-propagation.test.ts`
- Modify: `apps/web/src/lib/admin/worker-client.ts`
- Modify: `apps/web/src/lib/admin/worker-client.test.ts`
- Modify: `apps/web/src/app/api/admin/v1/ats/[sourceKey]/policy/route.ts`
- Modify: `apps/web/src/app/api/admin/v1/ats/[sourceKey]/pause/route.ts`
- Modify: `apps/web/src/app/api/admin/v1/ats/[sourceKey]/resume/route.ts`
- Modify: corresponding route tests

- [ ] **Step 1: Write failing acknowledgement tests**

```ts
it('records an acknowledgement only after a matching Worker version', async () => {
  workerClient.mockResolvedValue({ receipt: 'r1', acknowledgedVersion: 4 })
  await acknowledgeCommittedAtsPolicy(deps, commandForVersion(4))
  expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sourceKey: 'lever', version: 4 } }))
})

it('leaves propagation pending when the Worker returns a different version', async () => {
  workerClient.mockResolvedValue({ receipt: 'r1', acknowledgedVersion: 3 })
  await expect(acknowledgeCommittedAtsPolicy(deps, commandForVersion(4))).resolves.toBe('pending')
})
```

- [ ] **Step 2: Run the focused Web tests and observe failure**

Run: `pnpm --filter web test -- src/lib/admin/ats-policy-propagation.test.ts src/lib/admin/worker-client.test.ts`

- [ ] **Step 3: Implement response validation and post-commit helper**

`sendWorkerCommand` exposes an optional numeric `acknowledgedVersion`.
`acknowledgeCommittedAtsPolicy` sends the command after `runAdminMutation`
returns, requires a matching version, and uses a version-qualified
`updateMany` to avoid acknowledging a newer concurrent policy.

- [ ] **Step 4: Move each ATS route side effect after its transaction**

The policy, approved pause, and resume routes persist and audit `pending`
state inside `runAdminMutation`. After the transaction commits they invoke the
helper and return the actual `pending` or `acknowledged` result. Pending
second-approver pauses do not send a command.

- [ ] **Step 5: Run affected Web tests**

Run: `pnpm --filter web test -- src/lib/admin/ats-policy-propagation.test.ts src/lib/admin/worker-client.test.ts src/app/api/admin/v1/ats/[sourceKey]/policy/route.test.ts src/app/api/admin/v1/ats/[sourceKey]/pause/route.test.ts src/app/api/admin/v1/ats/[sourceKey]/resume/route.test.ts`

- [ ] **Step 6: Commit post-commit propagation**

```powershell
git add apps/web/src/lib/admin/ats-policy-propagation.ts apps/web/src/lib/admin/ats-policy-propagation.test.ts apps/web/src/lib/admin/worker-client.ts apps/web/src/lib/admin/worker-client.test.ts apps/web/src/app/api/admin/v1/ats/[sourceKey]/policy/route.ts apps/web/src/app/api/admin/v1/ats/[sourceKey]/pause/route.ts apps/web/src/app/api/admin/v1/ats/[sourceKey]/resume/route.ts
git commit -m "fix(admin): confirm committed ATS policy versions"
```

### Task 5: Enforce version loading in the Worker control plane

**Files:**
- Modify: `apps/worker/src/admin/control-plane.ts`
- Create: `apps/worker/src/admin/control-plane.test.ts`

- [ ] **Step 1: Write failing control-plane tests**

```ts
it('acknowledges only the version read from the committed policy row', async () => {
  const result = await applyAtsPolicyCommand(deps, { sourceKey: 'lever', version: 4 })
  expect(result).toEqual({ acknowledgedVersion: 4 })
})

it('rejects a missing or stale requested version', async () => {
  await expect(applyAtsPolicyCommand(deps, { sourceKey: 'lever', version: 5 })).rejects.toThrow('not committed')
})
```

- [ ] **Step 2: Run the failing test**

Run: `pnpm --filter @jobcopilot/worker test -- src/admin/control-plane.test.ts`

- [ ] **Step 3: Validate command parameters against the shared allow-list**

Extract a testable command handler that loads the effective policy snapshot,
requires `configured` and exact `version`, and returns that exact version. The
HTTP handler maps stale/missing policy to a non-2xx response and keeps existing
HMAC, nonce, and queue behavior intact.

- [ ] **Step 4: Run all control tests**

Run: `pnpm --filter @jobcopilot/worker test -- src/admin/control-auth.test.ts src/admin/control-plane.test.ts src/admin/ats-policy.test.ts`

- [ ] **Step 5: Commit the real control-plane acknowledgement**

```powershell
git add apps/worker/src/admin/control-plane.ts apps/worker/src/admin/control-plane.test.ts
git commit -m "fix(worker): verify ATS policy acknowledgements"
```

### Task 6: Make registered platform flags and operational UI truthful

**Files:**
- Create: `packages/shared/src/feature-flags.ts`
- Create: `packages/shared/src/feature-flags.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`
- Create: `apps/web/src/lib/runtime-feature-flags.ts`
- Create: `apps/web/src/lib/runtime-feature-flags.test.ts`
- Create: `apps/worker/src/admin/runtime-feature-flags.ts`
- Create: `apps/worker/src/admin/runtime-feature-flags.test.ts`
- Modify: `apps/web/src/lib/admin/feature-flags.ts`
- Modify: `apps/web/src/lib/auto-apply.ts`
- Modify: `apps/worker/src/queue/scout-queue.ts`
- Modify: `apps/worker/src/queue/apply-queue.ts`
- Modify: `apps/web/src/components/admin/AdminPlatformPage.tsx`
- Modify: `apps/web/src/components/admin/AdminAtsControls.tsx`
- Modify: `apps/web/src/app/api/admin/v1/ats/route.ts`
- Modify: `apps/web/src/app/api/admin/v1/ats/[sourceKey]/health/route.ts`
- Modify: `apps/web/src/components/admin/OperationsPages.tsx`
- Modify: `apps/web/src/app/api/admin/v1/queues/[queue]/{pause,resume}/route.ts`

- [ ] **Step 1: Write failing pure-runtime tests**

```ts
it('uses the existing default unless an active registered flag overrides it', () => {
  expect(evaluateManagedFeature('unattended_apply', audienceWithoutFlag)).toBe(true)
  expect(evaluateManagedFeature('unattended_apply', disabledFlagAudience)).toBe(false)
})

it('rejects an arbitrary platform flag key before it can become active', () => {
  expect(parseFeatureFlag({
    key: 'new_feature',
    environment: 'development',
    enabled: true,
    rolloutPercent: 100,
    targetPlans: [],
    targetUserIds: [],
  })).toBeNull()
})
```

- [ ] **Step 2: Run the tests and observe the missing-module or assertion failure**

Run: `pnpm --filter @jobcopilot/shared test -- src/feature-flags.test.ts`
Run: `pnpm --filter web test -- src/lib/admin/feature-flags.test.ts`

- [ ] **Step 3: Implement the shared registry and Web/Worker evaluators**

Export only `worker_discovery` and `unattended_apply` from the shared registry.
Use a deterministic non-cryptographic rollout bucket over user, key, and
environment. Web looks up the active record and user plan before queueing an
unattended task. Worker independently looks up the same data before Scout
work and before browser navigation. A missing feature-flag table returns the
registry default for rollout-safe staged deployment; another read failure
blocks the affected automated operation.

- [ ] **Step 4: Add source-gate and UI-contract tests**

```ts
it('does not enqueue an unattended browser task when the platform flag is off', async () => {
  await expect(queueApplicationFill(input)).rejects.toThrow('temporarily unavailable')
  expect(enqueueApplyTask).not.toHaveBeenCalled()
})

it('serializes backoff and auto-apply fields from the ATS editor request', () => {
  expect(toAtsPolicyPayload(policy)).toMatchObject({ backoffBaseMs: 1000, allowAutoApply: true })
})
```

Confirm direct ATS rows report `credentialRequirement: 'none'`, and only
registered keys are selectable in the platform-controls UI.

- [ ] **Step 5: Move queue commands after their audit transaction**

Commit the idempotency/audit request first, then send the signed Worker
command. On dispatch failure, write a separate failed audit record and return
an unavailable response; do not claim the queue changed. Test that a successful
response contains the Worker receipt and a failed response includes no success
claim.

- [ ] **Step 6: Run focused Web and Worker tests**

Run: `pnpm --filter @jobcopilot/shared test -- src/feature-flags.test.ts`
Run: `pnpm --filter web test -- src/lib/runtime-feature-flags.test.ts src/lib/admin/feature-flags.test.ts src/lib/auto-apply.test.ts src/app/api/admin/v1/ats/route.test.ts`
Run: `pnpm --filter @jobcopilot/worker test -- src/admin/runtime-feature-flags.test.ts src/queue/scout-queue.test.ts src/queue/apply-queue-policy.test.ts`

- [ ] **Step 7: Commit the truthful platform-control wiring**

```powershell
git add packages/shared apps/web/src/lib/runtime-feature-flags.ts apps/web/src/lib/admin/feature-flags.ts apps/web/src/lib/auto-apply.ts apps/web/src/components/admin apps/web/src/app/api/admin/v1 apps/worker/src/admin/runtime-feature-flags.ts apps/worker/src/queue
git commit -m "fix(admin): enforce runtime platform controls"
```

### Task 7: Complete cross-product verification and handoff

**Files:**
- Modify: focused Settings/Admin tests only when audit reveals an untested behavior
- Preserve: `test-results/` untracked

- [ ] **Step 1: Re-run all focused Settings and admin tests**

Run: `pnpm --filter web test -- src/app/api/me/accounts/route.test.ts src/lib/admin/settings-access.test.ts src/app/api/admin/v1/users/[id]/settings/route.test.ts src/app/api/admin/v1/ats/[sourceKey]/policy/route.test.ts`

- [ ] **Step 2: Run the complete automated suite**

Run: `pnpm --filter web test`
Run: `pnpm --filter @jobcopilot/worker test`
Run: `pnpm --filter @jobcopilot/shared test`
Run: `pnpm --filter @jobcopilot/extension test`

- [ ] **Step 3: Run types and production builds**

Run: `pnpm --filter web typecheck`
Run: `pnpm --filter @jobcopilot/worker tsc`
Run: `pnpm --filter @jobcopilot/shared build`
Run: `pnpm --filter @jobcopilot/extension typecheck`
Run: `pnpm --filter web build`
Run: `pnpm --filter @jobcopilot/worker build`
Run: `pnpm --filter @jobcopilot/extension build`

- [ ] **Step 4: Run browser and deployment preflight checks**

Run the existing Playwright suite, inspect Settings and admin pages through the
browser, verify anonymous admin rejection, and run read-only migration,
administrator-permission, and worker-control-environment checks. Do not mutate
production credentials or data.

- [ ] **Step 5: Commit, push, and evaluate merge readiness**

```powershell
git add <only task files and docs>
git commit -m "fix(platform): enforce settings and ATS admin integration"
git push origin feat/settings-admin-wiring
```

Inspect the PR checks and deployment prerequisites before removing Draft status
or recommending a merge.
