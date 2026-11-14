import { randomUUID, createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"

import { createApplicationSubmitRepository, type SubmissionClaimAuthorizer } from "../db/application-submit-repo.js"
import { finishApplicationTask, markSubmissionRequestStarted } from "../db/application-task-state.js"
import { createPgApprovalStore } from "../runtime/approval/pg-store.js"
import { recordApplicationSubmissionEvidence, type ApplicationSubmissionEvidenceData } from "./application-submission-evidence.js"
import {
  recordSubmissionExecutionSettled,
  withExactAttemptFence,
  type ApplicationSubmissionExecution,
} from "./application-submit-fence.js"

const CI_DATABASE = "applymate_agent_brain_ci"
const LOCAL_DATABASE = "applymate_submission_evidence_1134_test"

function disposableDatabaseUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Submission evidence PostgreSQL requires an explicitly disposable database URL")
    return null
  }
  const url = new URL(value)
  const database = decodeURIComponent(url.pathname.slice(1))
  const expectedDatabase = process.env.CI === "true" ? CI_DATABASE : LOCAL_DATABASE
  if (url.protocol !== "postgresql:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.port !== (process.env.CI === "true" ? "5432" : "55434") || url.username !== "postgres" || url.password !== "postgres"
    || database !== expectedDatabase || url.search || url.hash) {
    throw new Error("Submission evidence PostgreSQL accepts only its named loopback disposable database")
  }
  if (required && process.env.CI !== "true") throw new Error("Required submission evidence PostgreSQL must run in CI")
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2_000, statement_timeout: 8_000, query_timeout: 10_000 }) : null
const userIds = new Set<string>()
const sessionIds = new Set<string>()
const receiptIds = new Set<string>()

type Fixture = Readonly<{
  scope: ApplicationSubmissionExecution
  fillerTaskId: string
  artifactHash: string
  attemptId: string
}>
type ApprovalStore = ReturnType<typeof createPgApprovalStore>

function id(prefix: string): string { return `${prefix}-${randomUUID()}` }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex") }
function isCurrent(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function errorCode(error: unknown): string | undefined {
  if (!isCurrent(error) || typeof error.code !== "string") return undefined
  return error.code
}

async function installProjectionPause(seconds: "0.25" | "1"): Promise<string> {
  const name = `se_projection_pause_${randomUUID().replace(/-/g, "")}`
  await pool!.query(`CREATE SEQUENCE "${name}"`)
  await pool!.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('"${name}"'); PERFORM pg_sleep(${seconds}); RETURN NEW; END $$`)
  await pool!.query(`CREATE TRIGGER "${name}" BEFORE INSERT ON "application_task_events"
    FOR EACH ROW WHEN (NEW."type" = 'submission_evidence_recorded') EXECUTE FUNCTION "${name}"()`)
  return name
}

async function removeProjectionPause(name: string): Promise<void> {
  await pool!.query(`DROP TRIGGER IF EXISTS "${name}" ON "application_task_events"`)
  await pool!.query(`DROP FUNCTION IF EXISTS "${name}"()`)
  await pool!.query(`DROP SEQUENCE IF EXISTS "${name}"`)
}

async function waitForProjectionPause(name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool!.query<{ is_called: boolean }>(`SELECT is_called FROM "${name}"`)
    if (result.rows[0]?.is_called) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Submission evidence insert did not reach its concurrency barrier")
}

async function configureCandidateRls(): Promise<void> {
  const identity = await pool!.query<{ database: string; user: string }>("SELECT current_database() AS database, current_user AS user")
  const expected = process.env.CI === "true" ? CI_DATABASE : LOCAL_DATABASE
  if (identity.rows[0]?.database !== expected || identity.rows[0]?.user !== "postgres") {
    throw new Error("Submission evidence test reached an unexpected disposable PostgreSQL identity")
  }
}

async function insertBaseRows(label: string): Promise<{
  userId: string; sessionId: string; turnId: string; applicationTaskId: string; jobId: string; fillerTaskId: string;
  approvalId: string; workerTaskId: string; executionId: string; artifactHash: string; materialHash: string; answersHash: string;
}> {
  const userId = id(`evidence-user-${label}`)
  const sessionId = id(`evidence-session-${label}`)
  const turnId = id(`evidence-turn-${label}`)
  const applicationTaskId = id(`evidence-task-${label}`)
  const jobId = id(`evidence-job-${label}`)
  const fillerTaskId = id(`evidence-filler-${label}`)
  const approvalId = id(`evidence-approval-${label}`)
  const workerTaskId = id(`evidence-worker-${label}`)
  const executionId = randomUUID()
  const artifactHash = digest(`application-artifact:${applicationTaskId}`)
  const materialHash = digest(`application-material:${applicationTaskId}`)
  const answersHash = digest(`application-answers:${applicationTaskId}`)
  userIds.add(userId)
  sessionIds.add(sessionId)
  receiptIds.add(approvalId)

  await pool!.query(`INSERT INTO "User" ("id", "email", "onboardingGoals", "updatedAt")
    VALUES ($1, $2, ARRAY[]::text[], NOW())`, [userId, `${userId}@example.invalid`])
  await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "url", "updatedAt")
    VALUES ($1, $2, 'Fixture Employer', 'Application Evidence Test', 'https://jobs.example.invalid/apply', NOW())`, [jobId, userId])
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt")
    VALUES ($1, $2, 'Disposable submission evidence fixture', 'running', 'test', 0, NOW())`, [sessionId, userId])
  await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NOW())`, [turnId, sessionId, userId])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "updatedAt")
    VALUES ($1, $2, $3, 'application_filler', 'application_fill_for_review', 'completed', 'Fixture application fill',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, NOW())`, [fillerTaskId, sessionId, turnId])
  await pool!.query(`INSERT INTO "application_tasks" ("id", "userId", "jobId", "sessionId", "fillTurnId",
    "fillTurnSessionId", "fillTurnUserId", "status", "checkpoint", "workerTaskId", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $4, $2, 'filling', 'browser_active', $6, NOW())`,
  [applicationTaskId, userId, jobId, sessionId, turnId, workerTaskId])
  return { userId, sessionId, turnId, applicationTaskId, jobId, fillerTaskId, approvalId, workerTaskId, executionId, artifactHash, materialHash, answersHash }
}

async function createFixture(label: string): Promise<Fixture> {
  const rows = await insertBaseRows(label)
  const approvals: ApprovalStore = createPgApprovalStore(pool!, { userId: rows.userId })
  const issued = await approvals.issue({
    approvalId: rows.approvalId,
    taskId: rows.applicationTaskId,
    scope: {
      userId: rows.userId, sessionId: rows.sessionId, turnId: rows.turnId, jobId: rows.jobId,
      toolCallId: `application-submit:${rows.applicationTaskId}`, action: "submit_application",
      resourceHash: rows.artifactHash, materialHash: rows.materialHash, answersHash: rows.answersHash,
      revision: 0, expiresAt: new Date(Date.now() + 60 * 60_000),
    },
    title: "Review application submission",
    body: "Approve this disposable application submission fixture.",
    payload: { applicationTaskId: rows.applicationTaskId, jobId: rows.jobId },
    nonce: randomUUID(),
  })
  await approvals.resolve({ id: rows.approvalId, sessionId: rows.sessionId, decision: "approved" })
  const scope: ApplicationSubmissionExecution = {
    sessionId: rows.sessionId,
    fillTurnId: rows.turnId,
    applicationTaskId: rows.applicationTaskId,
    userId: rows.userId,
    jobId: rows.jobId,
    approvalId: rows.approvalId,
    constraintHash: issued.approval.scopeHash,
    workerTaskId: rows.workerTaskId,
    executionId: rows.executionId,
  }
  const repository = createApplicationSubmitRepository(pool!)
  const authorizer: SubmissionClaimAuthorizer = async (client, mode) => {
    const approval = mode === "new"
      ? await approvals.consumeSubmissionInTransaction(client, scope.approvalId, scope)
      : await approvals.inspectSubmissionInTransaction(client, scope.approvalId, scope)
    return approval ? { kind: "authorized", artifactHash: approval.scope.resourceHash } : { kind: "fenced" }
  }
  const claim = await repository.reserveAndConsume(scope, authorizer)
  if (claim.kind !== "reserved") throw new Error("The production repository did not reserve the approved fixture attempt")
  return { scope, fillerTaskId: rows.fillerTaskId, artifactHash: rows.artifactHash, attemptId: claim.attempt.id }
}

async function insertQueuedEvent(fixture: Fixture, suffix = "queued"): Promise<void> {
  const scope = fixture.scope
  await pool!.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data")
    VALUES ($1, $2, 'submission_queued', 'user', 'User approved this job for background submission.', $3::jsonb)`, [
    id(`evidence-${suffix}`), scope.applicationTaskId, JSON.stringify({
      applicationTaskId: scope.applicationTaskId, userId: scope.userId, jobId: scope.jobId,
      sessionId: scope.sessionId, fillTurnId: scope.fillTurnId, approvalId: scope.approvalId,
      receiptId: scope.approvalId, constraintHash: scope.constraintHash, workerTaskId: scope.workerTaskId,
    }),
  ])
}

async function markRequestStarted(fixture: Fixture): Promise<void> {
  const client = await pool!.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", fixture.scope.userId])
    const fenced = await withExactAttemptFence(client, fixture.scope, () => markSubmissionRequestStarted(client, {
      ...fixture.scope, turnId: fixture.scope.fillTurnId,
    }))
    if (fenced.kind !== "current" || fenced.value !== "started") throw new Error("The production submission start marker was not written")
    await client.query("COMMIT")
    open = false
  } catch (error: unknown) {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function markAttemptSubmitted(fixture: Fixture, responseRef: string): Promise<void> {
  const result = await createApplicationSubmitRepository(pool!).markSubmitted(fixture.scope, responseRef)
  if (result.kind !== "updated" || result.attempt.id !== fixture.attemptId) throw new Error("The production repository did not submit the reserved fixture attempt")
}

async function markTaskSubmitted(fixture: Fixture): Promise<void> {
  const result = await finishApplicationTask(
    pool!, fixture.scope.applicationTaskId, "submitted", "submission_verified", null, "submit", fixture.scope,
  )
  if (result !== "current") throw new Error("The production task finalizer did not complete the fixture submission")
}

async function insertSettledEvent(fixture: Fixture): Promise<void> {
  const scope = fixture.scope
  await pool!.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data")
    VALUES ($1, $2, 'submission_execution_settled', 'worker', 'Submit execution settled', $3::jsonb)`, [
    id("evidence-settled-fixture"), scope.applicationTaskId, JSON.stringify({
      executionId: scope.executionId, workerTaskId: scope.workerTaskId, applicationTaskId: scope.applicationTaskId,
      userId: scope.userId, jobId: scope.jobId, sessionId: scope.sessionId, fillTurnId: scope.fillTurnId,
      approvalId: scope.approvalId, constraintHash: scope.constraintHash,
    }),
  ])
}

async function prepareEvidenceRows(label: string, responseRef = "application:unused"): Promise<Fixture> {
  const fixture = await createFixture(label)
  await insertQueuedEvent(fixture)
  await markRequestStarted(fixture)
  await markAttemptSubmitted(fixture, responseRef === "application:unused" ? `application:${fixture.scope.applicationTaskId}` : responseRef)
  await markTaskSubmitted(fixture)
  await insertSettledEvent(fixture)
  return fixture
}

async function evidenceRows(fixture: Fixture): Promise<Array<{ id: string; data: ApplicationSubmissionEvidenceData }>> {
  const result = await pool!.query<{ id: string; data: ApplicationSubmissionEvidenceData }>(
    `SELECT "id", "data" FROM "application_task_events" WHERE "taskId" = $1 AND "type" = 'submission_evidence_recorded'`,
    [fixture.scope.applicationTaskId],
  )
  return result.rows
}

async function assertNoEvidence(fixture: Fixture): Promise<void> {
  expect(await evidenceRows(fixture)).toEqual([])
}

async function candidateTransaction<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool!.connect()
  try {
    await client.query("BEGIN")
    await client.query("SET LOCAL statement_timeout = '10000ms'")
    await client.query("SET LOCAL app.applymate_enable_rls = 'on'")
    const enable = await readFile(new URL("../../../web/prisma/rls/enable.sql", import.meta.url), "utf8")
    const grants = await readFile(new URL("../../../web/prisma/rls/role-grants.sql", import.meta.url), "utf8")
    await client.query(enable)
    await client.query(grants)
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", userId])
    await client.query("SET LOCAL ROLE applymate_candidate")
    return await work(client)
  } finally {
    try { await client.query("ROLLBACK") } finally { client.release() }
  }
}

describeWithPostgres("application submission evidence on disposable PostgreSQL", () => {
  beforeAll(async () => { await configureCandidateRls() }, 20_000)

  afterAll(async () => {
    if (!pool) return
    try {
      const client = await pool.connect()
      let open = false
      try {
        await client.query("BEGIN")
        open = true
        await client.query("SET LOCAL statement_timeout = '10000ms'")
        const sessions = [...sessionIds]
        const receipts = [...receiptIds]
        if (sessions.length) await client.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [sessions])
        if (receipts.length) await client.query(`DELETE FROM "submission_attempt" WHERE "receiptId" = ANY($1::text[])`, [receipts])
        if (userIds.size) await client.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [[...userIds]])
        await client.query("COMMIT")
        open = false
      } catch (error: unknown) {
        if (open) await client.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { client.release() }
    } finally { await pool.end() }
  }, 20_000)

  it("records current approved submission evidence with an exact local application reference", async () => {
    const fixture = await createFixture("correlated")
    await insertQueuedEvent(fixture)
    await markRequestStarted(fixture)
    await markAttemptSubmitted(fixture, `application:${fixture.scope.applicationTaskId}`)
    await markTaskSubmitted(fixture)
    await expect(recordSubmissionExecutionSettled(pool!, fixture.scope)).resolves.toBe(true)

    const rows = await evidenceRows(fixture)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data).toMatchObject({
      schemaVersion: 1, ...fixture.scope, attemptId: fixture.attemptId, artifactHash: fixture.artifactHash,
      workerReport: "recorded_submitted", localRecord: "correlated", siteOutcome: "unverified",
    })
    expect(Object.keys(rows[0]!.data).sort()).toEqual([
      "approvalId", "applicationTaskId", "artifactHash", "attemptId", "constraintHash", "executionId", "fillTurnId",
      "jobId", "localRecord", "schemaVersion", "sessionId", "siteOutcome", "userId", "workerReport", "workerTaskId",
    ].sort())
    expect(JSON.stringify(rows[0]?.data)).not.toContain(`application:${fixture.scope.applicationTaskId}`)
    const state = await pool!.query<{ status: string; state: string; approvalStatus: string }>(
      `SELECT task."status", task."checkpoint", attempt."state", approval."status" AS "approvalStatus"
       FROM "application_tasks" task JOIN "submission_attempt" attempt ON attempt."receiptId" = $1
       JOIN "agent_approvals" approval ON approval."id" = $1 WHERE task."id" = $2`,
      [fixture.scope.approvalId, fixture.scope.applicationTaskId],
    )
    expect(state.rows[0]).toMatchObject({
      status: "submitted", checkpoint: "submission_verified", state: "submitted", approvalStatus: "consumed",
    })
  })

  it("keeps another nonempty provider reference unavailable instead of treating it as an ATS receipt", async () => {
    const fixture = await createFixture("unavailable")
    await insertQueuedEvent(fixture)
    await markRequestStarted(fixture)
    const opaqueResponseRef = `opaque-provider-${randomUUID()}`
    await markAttemptSubmitted(fixture, opaqueResponseRef)
    await markTaskSubmitted(fixture)
    await expect(recordSubmissionExecutionSettled(pool!, fixture.scope)).resolves.toBe(true)
    const rows = await evidenceRows(fixture)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data.localRecord).toBe("unavailable")
    expect(rows[0]?.data.siteOutcome).toBe("unverified")
    expect(JSON.stringify(rows[0]?.data)).not.toContain(opaqueResponseRef)
  })

  it("writes at most one evidence event for an exact submitted attempt replay", async () => {
    const fixture = await createFixture("replay")
    await insertQueuedEvent(fixture)
    await markRequestStarted(fixture)
    await markAttemptSubmitted(fixture, `application:${fixture.scope.applicationTaskId}`)
    await markTaskSubmitted(fixture)
    await expect(recordSubmissionExecutionSettled(pool!, fixture.scope)).resolves.toBe(true)
    await expect(recordSubmissionExecutionSettled(pool!, fixture.scope)).resolves.toBe(false)
    const rows = await evidenceRows(fixture)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data.attemptId).toBe(fixture.attemptId)

    const failedProjection = await createFixture("projection-failure")
    await insertQueuedEvent(failedProjection)
    await markRequestStarted(failedProjection)
    await markAttemptSubmitted(failedProjection, `application:${failedProjection.scope.applicationTaskId}`)
    await markTaskSubmitted(failedProjection)
    const name = `se_reject_${randomUUID().replace(/-/g, "")}`
    try {
      await pool!.query(`CREATE SEQUENCE "${name}"`)
      await pool!.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('"${name}"'); RAISE EXCEPTION 'fixture projection failure'; END $$`)
      await pool!.query(`CREATE TRIGGER "${name}" BEFORE INSERT ON "application_task_events"
        FOR EACH ROW WHEN (NEW."type" = 'submission_evidence_recorded') EXECUTE FUNCTION "${name}"()`)
      await expect(recordSubmissionExecutionSettled(pool!, failedProjection.scope)).resolves.toBe(true)
      const settled = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "application_task_events" WHERE "taskId" = $1 AND "type" = 'submission_execution_settled'`,
        [failedProjection.scope.applicationTaskId],
      )
      expect(settled.rows[0]?.count).toBe("1")
      const fired = await pool!.query<{ is_called: boolean }>(`SELECT is_called FROM "${name}"`)
      expect(fired.rows[0]?.is_called).toBe(true)
      await assertNoEvidence(failedProjection)
    } finally {
      await pool!.query(`DROP TRIGGER IF EXISTS "${name}" ON "application_task_events"`)
      await pool!.query(`DROP FUNCTION IF EXISTS "${name}"()`)
      await pool!.query(`DROP SEQUENCE IF EXISTS "${name}"`)
    }
    await expect(recordSubmissionExecutionSettled(pool!, failedProjection.scope)).resolves.toBe(false)
    expect(await evidenceRows(failedProjection)).toHaveLength(1)
  })

  it("deduplicates simultaneous projections for the same settled tuple", async () => {
    const fixture = await prepareEvidenceRows("concurrent-projection")
    const name = await installProjectionPause("0.25")
    try {
      let insertArrivals = 0
      let releaseInserts!: () => void
      const insertBarrier = new Promise<void>(resolve => { releaseInserts = resolve })
      const concurrentPool = {
        connect: async () => {
          const client = await pool!.connect()
          return {
            query: async (sql: string, values?: unknown[]) => {
              if (sql.includes("INSERT INTO \"application_task_events\"") && sql.includes("submission_evidence_recorded")) {
                insertArrivals += 1
                if (insertArrivals === 2) releaseInserts()
                await insertBarrier
              }
              return client.query(sql, values)
            },
            release: (error?: Error | boolean) => client.release(error),
          }
        },
      } as unknown as Pool
      const outcomes = await Promise.all([
        recordApplicationSubmissionEvidence(concurrentPool, fixture.scope),
        recordApplicationSubmissionEvidence(concurrentPool, fixture.scope),
      ])
      expect(insertArrivals).toBe(2)
      expect(outcomes.sort()).toEqual([false, true])
      const attempts = await pool!.query<{ last_value: string }>(`SELECT last_value::text FROM "${name}"`)
      expect(attempts.rows[0]?.last_value).toBe("2")
      const rows = await evidenceRows(fixture)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.data).toMatchObject({
        ...fixture.scope, attemptId: fixture.attemptId, artifactHash: fixture.artifactHash,
        workerReport: "recorded_submitted", localRecord: "correlated", siteOutcome: "unverified",
      })
    } finally { await removeProjectionPause(name) }
  }, 20_000)

  it("keeps an old projection noncurrent when recovery changes the Worker binding during insert", async () => {
    const fixture = await prepareEvidenceRows("recovery-projection-race")
    const name = await installProjectionPause("1")
    const replacementWorkerTaskId = id("recovered-worker")
    try {
      const projection = recordApplicationSubmissionEvidence(pool!, fixture.scope)
      await waitForProjectionPause(name)
      await pool!.query(`UPDATE "application_tasks" SET "workerTaskId" = $1 WHERE "id" = $2`,
        [replacementWorkerTaskId, fixture.scope.applicationTaskId])
      await expect(projection).resolves.toBe(true)
    } finally { await removeProjectionPause(name) }

    const rows = await evidenceRows(fixture)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data.workerTaskId).toBe(fixture.scope.workerTaskId)
    expect(rows[0]?.data.workerTaskId).not.toBe(replacementWorkerTaskId)
    await candidateTransaction(fixture.scope.userId, async client => {
      const task = await client.query(
        `SELECT "id", "userId", "jobId", "sessionId", "fillTurnId", "fillTurnSessionId",
          "fillTurnUserId", "workerTaskId", "status", "checkpoint" FROM "application_tasks" WHERE "id" = $1`,
        [fixture.scope.applicationTaskId],
      )
      const events = await client.query(
        `SELECT "id", "type", "actor", "data" FROM "application_task_events" WHERE "taskId" = $1
          AND "type" IN ('submission_queued', 'submission_execution_started', 'submission_execution_settled', 'submission_evidence_recorded')`,
        [fixture.scope.applicationTaskId],
      )
      const approvals = await client.query(
        `SELECT "id", "userId", "sessionId", "taskId", "turnId", "jobId", "toolCallId",
          "type", "status", "scopeHash", "resourceHash" FROM "agent_approvals" WHERE "id" = $1`,
        [fixture.scope.approvalId],
      )
      const evaluatorUrl = new URL("../../../web/src/lib/agent/application-submission-evidence.ts", import.meta.url).href
      const evaluator = await import(/* @vite-ignore */ evaluatorUrl) as {
        evaluateApplicationSubmissionEvidence(input: unknown): unknown
      }
      expect(evaluator.evaluateApplicationSubmissionEvidence({ task: task.rows[0], events: events.rows, approvals: approvals.rows }))
        .toEqual({ visible: true, availability: "unknown", workerReport: "unknown", localRecord: "unknown", employerReceipt: "unverified" })
    })
  }, 20_000)

  it("rejects mismatched user, session, and fill-turn bindings", async () => {
    const fixture = await prepareEvidenceRows("identity-mismatch")
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, userId: id("other-user") })).resolves.toBe(false)
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, sessionId: id("other-session") })).resolves.toBe(false)
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, fillTurnId: id("other-turn") })).resolves.toBe(false)
    await assertNoEvidence(fixture)
  })

  it("rejects mismatched application-task and job bindings", async () => {
    const fixture = await prepareEvidenceRows("task-job-mismatch")
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, applicationTaskId: id("other-task") })).resolves.toBe(false)
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, jobId: id("other-job") })).resolves.toBe(false)
    await assertNoEvidence(fixture)
  })

  it("rejects mismatched approval, constraint, and artifact-hash bindings", async () => {
    const fixture = await prepareEvidenceRows("approval-hash-mismatch")
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, approvalId: id("other-approval") })).resolves.toBe(false)
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, constraintHash: digest("other-constraint") })).resolves.toBe(false)
    await pool!.query(`UPDATE "agent_approvals" SET "resourceHash" = $1 WHERE "id" = $2`, [digest("wrong-artifact"), fixture.scope.approvalId])
    await expect(recordApplicationSubmissionEvidence(pool!, fixture.scope)).resolves.toBe(false)
    await assertNoEvidence(fixture)

    const fillerSubject = await prepareEvidenceRows("approval-filler-subject")
    const changedSubject = await pool!.query<{ taskId: string }>(
      `UPDATE "agent_approvals" SET "taskId" = $1 WHERE "id" = $2 RETURNING "taskId"`,
      [fillerSubject.fillerTaskId, fillerSubject.scope.approvalId],
    )
    expect(changedSubject.rows[0]?.taskId).toBe(fillerSubject.fillerTaskId)
    await expect(recordApplicationSubmissionEvidence(pool!, fillerSubject.scope)).resolves.toBe(false)
    await assertNoEvidence(fillerSubject)
  })

  it("rejects mismatched Worker-job and execution bindings", async () => {
    const fixture = await prepareEvidenceRows("worker-execution-mismatch")
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, workerTaskId: id("other-worker") })).resolves.toBe(false)
    await expect(recordApplicationSubmissionEvidence(pool!, { ...fixture.scope, executionId: randomUUID() })).resolves.toBe(false)
    await assertNoEvidence(fixture)

    for (const eventType of ["submission_execution_started", "submission_execution_settled"] as const) {
      const missing = await prepareEvidenceRows(`missing-${eventType}`)
      await pool!.query(`DELETE FROM "application_task_events" WHERE "taskId" = $1 AND "type" = $2`,
        [missing.scope.applicationTaskId, eventType])
      await expect(recordApplicationSubmissionEvidence(pool!, missing.scope)).resolves.toBe(false)
      await assertNoEvidence(missing)

      const mismatched = await prepareEvidenceRows(`mismatched-${eventType}`)
      await pool!.query(`UPDATE "application_task_events" SET "data" = jsonb_set("data", '{executionId}', to_jsonb($3::text))
        WHERE "taskId" = $1 AND "type" = $2`, [mismatched.scope.applicationTaskId, eventType, randomUUID()])
      await expect(recordApplicationSubmissionEvidence(pool!, mismatched.scope)).resolves.toBe(false)
      await assertNoEvidence(mismatched)

      const duplicate = await prepareEvidenceRows(`duplicate-${eventType}`)
      await pool!.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data")
        SELECT $3, "taskId", "type", "actor", "body", "data" FROM "application_task_events"
        WHERE "taskId" = $1 AND "type" = $2`, [duplicate.scope.applicationTaskId, eventType, id("duplicate-event")])
      await expect(recordApplicationSubmissionEvidence(pool!, duplicate.scope)).resolves.toBe(false)
      await assertNoEvidence(duplicate)
    }
  }, 20_000)

  it("does not project an old Worker attempt after the current attempt changes", async () => {
    const fixture = await prepareEvidenceRows("old-worker")
    await pool!.query(`UPDATE "application_tasks" SET "workerTaskId" = $1 WHERE "id" = $2`, [id("replacement-worker"), fixture.scope.applicationTaskId])
    await expect(recordApplicationSubmissionEvidence(pool!, fixture.scope)).resolves.toBe(false)
    await assertNoEvidence(fixture)
  })

  it("does not project when the durable submission attempt is missing", async () => {
    const fixture = await prepareEvidenceRows("missing-attempt")
    await pool!.query(`DELETE FROM "submission_attempt" WHERE "id" = $1`, [fixture.attemptId])
    await expect(recordApplicationSubmissionEvidence(pool!, fixture.scope)).resolves.toBe(false)
    await assertNoEvidence(fixture)
  })

  it("does not project a reserved submission attempt", async () => {
    const fixture = await createFixture("reserved-attempt")
    await expect(recordApplicationSubmissionEvidence(pool!, fixture.scope)).resolves.toBe(false)
    await assertNoEvidence(fixture)
  })

  it("does not project a failed submission attempt", async () => {
    const fixture = await createFixture("failed-attempt")
    const failed = await createApplicationSubmitRepository(pool!).markFailed(fixture.scope, "fixture_failure")
    expect(failed.kind).toBe("updated")
    await expect(recordApplicationSubmissionEvidence(pool!, fixture.scope)).resolves.toBe(false)
    await assertNoEvidence(fixture)
  })

  it("requires one completed filler and unambiguous queued evidence", async () => {
    const missing = await prepareEvidenceRows("missing-filler")
    await pool!.query(`DELETE FROM "sub_agent_tasks" WHERE "id" = $1`, [missing.fillerTaskId])
    await expect(recordApplicationSubmissionEvidence(pool!, missing.scope)).resolves.toBe(false)
    await assertNoEvidence(missing)

    const incomplete = await prepareEvidenceRows("incomplete-filler")
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'failed' WHERE "id" = $1`, [incomplete.fillerTaskId])
    await expect(recordApplicationSubmissionEvidence(pool!, incomplete.scope)).resolves.toBe(false)
    await assertNoEvidence(incomplete)

    const ambiguousFiller = await prepareEvidenceRows("ambiguous-filler")
    await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "updatedAt")
      VALUES ($1, $2, $3, 'application_filler', 'application_fill_for_review', 'completed', 'Duplicate filler fixture',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, NOW())`,
    [id("duplicate-filler"), ambiguousFiller.scope.sessionId, ambiguousFiller.scope.fillTurnId])
    await expect(recordApplicationSubmissionEvidence(pool!, ambiguousFiller.scope)).resolves.toBe(false)
    await assertNoEvidence(ambiguousFiller)

    const ambiguousQueued = await prepareEvidenceRows("ambiguous-queued")
    await insertQueuedEvent(ambiguousQueued, "duplicate-queued")
    await expect(recordApplicationSubmissionEvidence(pool!, ambiguousQueued.scope)).resolves.toBe(false)
    await assertNoEvidence(ambiguousQueued)
  })

  it("allows candidate-role reads of own evidence but denies other-user events and private attempts", async () => {
    const own = await createFixture("rls-own")
    const foreign = await createFixture("rls-foreign")
    for (const fixture of [own, foreign]) {
      await insertQueuedEvent(fixture)
      await markRequestStarted(fixture)
      await markAttemptSubmitted(fixture, `application:${fixture.scope.applicationTaskId}`)
      await markTaskSubmitted(fixture)
      await expect(recordSubmissionExecutionSettled(pool!, fixture.scope)).resolves.toBe(true)
    }
    const ownEvent = (await evidenceRows(own))[0]
    const foreignEvent = (await evidenceRows(foreign))[0]
    expect(ownEvent).toBeDefined()
    expect(foreignEvent).toBeDefined()

    await candidateTransaction(own.scope.userId, async client => {
      await client.query("SAVEPOINT private_read")
      let privateReadError: unknown
      try { await client.query('SELECT "id" FROM "submission_attempt" WHERE "receiptId" = $1', [own.scope.approvalId]) }
      catch (error: unknown) { privateReadError = error }
      await client.query("ROLLBACK TO SAVEPOINT private_read")
      expect(errorCode(privateReadError)).toBe("42501")
      const visible = await client.query<{ id: string }>(
        `SELECT "id" FROM "application_task_events" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
        [[ownEvent!.id, foreignEvent!.id]],
      )
      expect(visible.rows.map(row => row.id)).toEqual([ownEvent!.id])

      const task = await client.query(
        `SELECT "id", "userId", "jobId", "sessionId", "fillTurnId", "fillTurnSessionId",
          "fillTurnUserId", "workerTaskId", "status", "checkpoint" FROM "application_tasks" WHERE "id" = $1`,
        [own.scope.applicationTaskId],
      )
      const events = await client.query(
        `SELECT "id", "type", "actor", "data" FROM "application_task_events" WHERE "taskId" = $1
          AND "type" IN ('submission_queued', 'submission_execution_started', 'submission_execution_settled', 'submission_evidence_recorded')`,
        [own.scope.applicationTaskId],
      )
      const approvals = await client.query(
        `SELECT "id", "userId", "sessionId", "taskId", "turnId", "jobId", "toolCallId",
          "type", "status", "scopeHash", "resourceHash" FROM "agent_approvals" WHERE "id" = $1`,
        [own.scope.approvalId],
      )
      const evaluatorUrl = new URL("../../../web/src/lib/agent/application-submission-evidence.ts", import.meta.url).href
      const evaluator = await import(/* @vite-ignore */ evaluatorUrl) as {
        evaluateApplicationSubmissionEvidence(input: unknown): unknown
      }
      expect(evaluator.evaluateApplicationSubmissionEvidence({ task: task.rows[0], events: events.rows, approvals: approvals.rows }))
        .toEqual({ visible: true, availability: "available", workerReport: "submitted", localRecord: "recorded", employerReceipt: "unverified" })
    })
  })
})
