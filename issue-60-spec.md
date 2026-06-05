## Problem

When a BullMQ task is dequeued, `apply-queue.ts` passes an empty `persona: {}` and blank `jobTitle`/`jobCompany` to AgentHarness. The LLM has no candidate data to fill fields with — it will leave everything blank. Auto-apply is technically running but producing zero-quality results.

## Goal

Before calling AgentHarness, the worker loads real data from Postgres:
1. User's persona (name, email, phone, location, linkedin + personaFields)
2. Job row (title, company, keywords, description, applyUrl)

## Acceptance Criteria

- [ ] **AC1**: New file `apps/worker/src/db/load-task-context.ts` that exports:
  ```typescript
  export interface TaskContext {
    persona: Record<string, string>  // flat key→value map
    jobTitle: string
    jobCompany: string
    jobKeywords: string
    applyUrl: string                 // resolved from job.url (fallback to task.applyUrl)
    coverLetterText: string | null   // from job.coverLetter
  }

  export async function loadTaskContext(
    userId: string,
    jobId: string,
    fallbackApplyUrl: string,
  ): Promise<TaskContext>
  ```

- [ ] **AC2**: Persona built from User row:
  ```typescript
  // Base fields always included:
  const base = {
    fullName: user.name ?? '',
    email: user.email ?? '',
    phone: user.phone ?? '',
    location: user.location ?? '',
    linkedinUrl: user.linkedin ?? '',
  }
  // Merge personaFields (PersonaField[] stored as JSON):
  // Each PersonaField has { key: string, value: string }
  const learned = Object.fromEntries(
    ((user.personaFields as Array<{ key: string; value: string }>) ?? [])
      .map(f => [f.key, f.value])
  )
  persona = { ...base, ...learned }
  ```

- [ ] **AC3**: Job row loaded from `Job` table via raw SQL:
  ```sql
  SELECT role, company, keywords, description, url, "coverLetter"
  FROM "Job" WHERE id = $1 AND "userId" = $2
  ```
  If job not found: throw Error(`Job ${jobId} not found for user ${userId}`)

- [ ] **AC4**: User row loaded from `User` table via raw SQL:
  ```sql
  SELECT name, email, phone, location, linkedin, "personaFields"
  FROM "User" WHERE id = $1
  ```

- [ ] **AC5**: `apply-queue.ts` updated — call `loadTaskContext` before creating `ApplyTask`:
  ```typescript
  const ctx = await loadTaskContext(userId, jobId, applyUrl)
  const applyTask: ApplyTask = {
    jobId,
    applyUrl: ctx.applyUrl,
    persona: ctx.persona,
    jobTitle: ctx.jobTitle,
    jobCompany: ctx.jobCompany,
    jobKeywords: ctx.jobKeywords,
    resumePath: resumePath,
    coverLetterPath: undefined,  // Phase 5: PDF generation
  }
  ```

- [ ] **AC6**: Unit tests `load-task-context.test.ts`:
  - Happy path: returns correct persona + job fields
  - Missing job: throws with meaningful message
  - Empty personaFields: base fields still present
  - Learned personaFields merged on top of base

- [ ] **AC7**: `pnpm --filter worker tsc --noEmit` passes

## Tech Notes

- Use the `pg` Pool from `apps/worker/src/db/apply-results.ts` — import `getPool()` if it's exported, or replicate the pattern
- Use the same `DATABASE_URL` env var
- `personaFields` column type in Postgres is `jsonb` — `pg` returns it as a JS object directly (no need to JSON.parse)
- `coverLetterText` comes from `job.coverLetter` (text content, not a file path) — pass it as context to the system prompt later in Phase 5
- File: `apps/worker/src/db/load-task-context.ts` (new) + update `apply-queue.ts`

## Verification

```bash
pnpm --filter worker test -- src/db/load-task-context.test.ts
pnpm --filter worker tsc --noEmit
```

---
@codex Branch: `feat/60-load-task-context`. PR with `Closes #60`. Comment `@claude ready for review` when done.
