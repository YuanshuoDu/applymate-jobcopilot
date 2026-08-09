# Worker Control Fly Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing HMAC-protected Web-to-Worker admin control plane reachable from Vercel through Fly while failing closed when a public Worker listener lacks its control secret.

**Architecture:** The Web app continues to send signed commands to the Worker control endpoint. Fly exposes the Worker HTTP service on its proxy address, while the Worker validates that a production public listener has `WORKER_CONTROL_SECRET` before it starts. The deployment guides and environment templates describe the same base URL and shared secret contract.

**Tech Stack:** TypeScript, Express, Vitest, Fly.io, Vercel, Prisma, pnpm.

---

### Task 1: Lock down public Worker listener configuration

**Files:**
- Modify: `apps/worker/src/admin/control-plane.test.ts`
- Modify: `apps/worker/src/admin/control-plane.ts`
- Modify: `apps/worker/src/index.ts`

- [x] **Step 1: Write the failing configuration tests**

Add tests for the desired boundary behavior:

```ts
import { resolveWorkerAdminHost } from './control-plane.js'

it('rejects a production public listener without a control secret', () => {
  expect(() => resolveWorkerAdminHost({ host: '0.0.0.0', environment: 'production', hasControlSecret: false }))
    .toThrow('WORKER_CONTROL_SECRET is required')
})

it('allows the Fly listener when the HMAC control secret is configured', () => {
  expect(resolveWorkerAdminHost({ host: '0.0.0.0', environment: 'production', hasControlSecret: true }))
    .toBe('0.0.0.0')
})
```

- [x] **Step 2: Run the focused test to verify the red state**

Run: `pnpm --filter @jobcopilot/worker test -- src/admin/control-plane.test.ts`

Expected: failure because `resolveWorkerAdminHost` is not exported.

- [x] **Step 3: Implement the smallest host resolver**

Add an exported resolver in `control-plane.ts` that defaults to `127.0.0.1`, accepts loopback/private listeners, and throws only when `NODE_ENV=production`, the requested host is `0.0.0.0` or `::`, and no control secret is configured. Replace the inline host check in `index.ts` with this resolver.

- [x] **Step 4: Run the focused Worker test to verify green**

Run: `pnpm --filter @jobcopilot/worker test -- src/admin/control-plane.test.ts`

Expected: all control-plane tests pass.

### Task 2: Align Fly and environment documentation

**Files:**
- Modify: `apps/worker/fly.toml`
- Modify: `apps/web/.env.example`
- Modify: `apps/worker/.env.example`
- Modify: `docs/auto-apply-deployment.md`
- Modify: `docs/admin-console-implementation-plan.md`

- [x] **Step 1: Declare Fly's proxy listener**

Add `WORKER_ADMIN_HOST = "0.0.0.0"` to `apps/worker/fly.toml` so Fly's `http_service` can reach port 3001. The process still refuses to start in production until its HMAC control secret exists.

- [x] **Step 2: Document the matching control-plane contract**

Update both environment templates to describe `WORKER_CONTROL_URL` as the Worker base URL without `/internal/admin/control`, and require `WORKER_CONTROL_SECRET` to match between Vercel and Fly. State that the Fly public route is HMAC protected and Bull Board remains disabled.

- [x] **Step 3: Make the production guide executable**

Update `docs/auto-apply-deployment.md` to include the two Web control variables, the Worker control secret, the Fly `secrets set` argument, current migrations, and a post-deploy administrator queue-control smoke check. Update `docs/admin-console-implementation-plan.md` to remove its incompatible private-network instruction and link it to the same HMAC-protected Fly contract. Keep secrets represented only by placeholders.

- [x] **Step 4: Review the rendered diff**

Run: `git diff --check`

Expected: no whitespace errors or leaked secret values.

### Task 3: Verify and hand off

**Files:**
- Verify: `apps/worker/src/admin/control-plane.test.ts`
- Verify: `apps/web/src/lib/admin/worker-client.test.ts`
- Verify: `docs/auto-apply-deployment.md`

- [x] **Step 1: Run focused control-plane tests**

Run:

```powershell
pnpm --filter @jobcopilot/worker test -- src/admin/control-plane.test.ts
pnpm --filter @jobcopilot/web test -- src/lib/admin/worker-client.test.ts
```

Expected: all selected tests pass.

- [x] **Step 2: Run type checks and serial full test suites**

Run:

```powershell
pnpm --filter @jobcopilot/shared build
pnpm --filter @jobcopilot/web exec prisma generate
pnpm --filter @jobcopilot/web typecheck
pnpm --filter @jobcopilot/worker exec tsc --noEmit --skipLibCheck
pnpm --filter @jobcopilot/web test -- --maxWorkers=1
pnpm --filter @jobcopilot/worker test
pnpm --filter @jobcopilot/shared test
```

Expected: all commands pass. The Web suite is serial because the local Windows runner can otherwise starve its five-second per-test budget during full parallel collection.

- [x] **Step 3: Build deployable artifacts**

Run:

```powershell
pnpm --filter @jobcopilot/web build
pnpm --filter @jobcopilot/worker build
```

Expected: production builds complete without errors.

- [ ] **Step 4: Commit and push the scoped fix**

Run:

```powershell
git add apps/worker/src/admin/control-plane.ts apps/worker/src/admin/control-plane.test.ts apps/worker/src/index.ts apps/worker/fly.toml apps/web/.env.example apps/worker/.env.example docs/auto-apply-deployment.md docs/admin-console-implementation-plan.md docs/superpowers/plans/2026-08-09-worker-control-fly-deployment.md
git commit -m "fix(worker): make Fly control plane deployable"
git push -u origin fix/243-worker-control-deployment-docs
```

Expected: the branch is available for review without touching the user's original working tree.
