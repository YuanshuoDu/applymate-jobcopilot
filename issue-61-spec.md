## Problem

There is no way for a user to trigger auto-apply on a job. The worker is running and ready, but no endpoint exists to enqueue a task from the web app UI.

## Goal

Add `POST /api/jobs/:id/auto-apply` to the web app, and a BullMQ producer client so the web app can enqueue tasks into the `apply-tasks` queue.

## Acceptance Criteria

- [ ] **AC1**: New file `apps/web/src/lib/apply-queue-client.ts`:
  ```typescript
  import { Queue } from 'bullmq'
  import { Redis } from 'ioredis'

  let _queue: Queue | null = null

  export function getApplyQueue(): Queue {
    if (!_queue) {
      const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      })
      _queue = new Queue('apply-tasks', { connection: redis })
    }
    return _queue
  }

  export interface EnqueueApplyTaskInput {
    jobId: string
    userId: string
    applyUrl: string
    personaId: string
    resumePath: string
    coverLetterPath?: string
    dryRun?: boolean
  }

  export async function enqueueApplyTask(input: EnqueueApplyTaskInput): Promise<string> {
    const queue = getApplyQueue()
    const job = await queue.add('apply', input, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    })
    return job.id!
  }
  ```

- [ ] **AC2**: New route `apps/web/src/app/api/jobs/[id]/auto-apply/route.ts`:
  ```typescript
  export async function POST(_req, { params }) {
    const auth = await requireAuth()
    if (isErrorResponse(auth)) return auth

    const { id: jobId } = await params
    const job = await db.job.findUnique({ where: { id: jobId } })
    if (!job || job.userId !== auth.userId) return err('Not found', 404)
    if (!job.url) return err('Job has no apply URL', 400)

    // Find user's default resume (for personaId — use userId as personaId for now)
    // resumePath is a placeholder — worker will load resume from DB by userId
    const bqJobId = await enqueueApplyTask({
      jobId,
      userId: auth.userId,
      applyUrl: job.url,
      personaId: auth.userId,   // personaId = userId for now (single persona per user)
      resumePath: `db:${auth.userId}`,  // sentinel — worker resolves from DB
      dryRun: false,
    })

    // Update job status to 'applied' (optimistic)
    await db.job.update({
      where: { id: jobId },
      data: { status: 'applied', appliedAt: new Date() },
    })

    return ok({ queued: true, taskId: bqJobId })
  }
  ```

- [ ] **AC3**: Add `bullmq` and `ioredis` to `apps/web/package.json` dependencies (same versions as `apps/worker`)

- [ ] **AC4**: Route returns `{ queued: true, taskId: string }` on success, `400` if job has no URL, `404` if not found

- [ ] **AC5**: `pnpm --filter web tsc --noEmit` passes — no type errors

- [ ] **AC6**: Unit test for the route:
  - Mock `db.job.findUnique`, `enqueueApplyTask`
  - Test: happy path returns 200 + queued:true
  - Test: job without URL returns 400
  - Test: job owned by different user returns 404

## Tech Notes

- `apps/web/src/lib/apply-queue-client.ts` must NOT import from `apps/worker` — it is a standalone BullMQ producer
- The `personaId: auth.userId` convention: worker uses userId to load User.personaFields (single persona per user for now)
- `resumePath: 'db:{userId}'` is a sentinel string — worker's `loadTaskContext` will detect `db:` prefix and load from DB instead of filesystem (update `load-task-context.ts` to handle this)
- Lockfile rule: add `bullmq` and `ioredis` to `apps/web/package.json` first, run `pnpm install` in clean worktree

## Verification

```bash
pnpm --filter web tsc --noEmit
pnpm --filter web test -- src/app/api/jobs/\[id\]/auto-apply/
```

---
@codex Branch: `feat/61-auto-apply-endpoint`. PR with `Closes #61`. Comment `@claude ready for review` when done.
