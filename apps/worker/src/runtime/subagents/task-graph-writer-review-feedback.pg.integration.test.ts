import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"

import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import { hashArtifactContent } from "./artifact-adapters.js"
import { PgArtifactToolStore } from "../tools/artifact-store-pg.js"
import type { ArtifactToolDraftInput, ArtifactToolRevisionContext, ArtifactToolScope, ArtifactVersionRef } from "../tools/artifact-tools.js"
import { loadSelectedJobArtifactContext, readSelectedJobSourceDigestWithClient } from "./selected-job-artifact-context.js"

const CI_DATABASE = "applymate_agent_brain_ci"
const LOCAL_DATABASE = "applymate_agent_artifact_review_842_test"

function disposableDatabaseUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Required artifact review PostgreSQL integration needs its explicitly disposable service URL")
    return null
  }

  const url = new URL(value)
  const database = decodeURIComponent(url.pathname.slice(1))
  const expectedDatabase = process.env.CI === "true" ? CI_DATABASE : LOCAL_DATABASE
  if (url.protocol !== "postgresql:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || database !== expectedDatabase || url.search || url.hash) {
    throw new Error("Artifact review PostgreSQL integration accepts only its named loopback disposable database")
  }
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const schema = `artifact_review_${randomUUID().replaceAll("-", "")}`
const admin = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8 }) : null
let testPool: Pool | null = null
let store: PgArtifactToolStore | null = null

function scopedPool(pool: Pool): Pool {
  return {
    async connect(): Promise<PoolClient> {
      const client = await pool.connect()
      try {
        await client.query(`SET search_path TO "${schema}"`)
        return client
      } catch (error: unknown) {
        client.release()
        throw error
      }
    },
    async query(sql: string, values?: unknown[]) {
      const client = await pool.connect()
      try {
        await client.query(`SET search_path TO "${schema}"`)
        return await client.query(sql, values)
      } finally {
        client.release()
      }
    },
  } as unknown as Pool
}

type Fixture = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly writerTaskId: string
  readonly reviewerTaskId: string
  readonly jobId: string
  readonly sourceDigest: string
  readonly writerFence: AgentArtifactTaskFence
  readonly reviewerFence: AgentArtifactTaskFence
  readonly scope: ArtifactToolScope
  readonly artifactRef: ArtifactVersionRef
  readonly revision: ArtifactToolRevisionContext
  readonly baseId: string
  readonly baseHash: string
}

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID()
  const userId = `artifact-review-user-${suffix}`
  const sessionId = `artifact-review-session-${suffix}`
  const turnId = `artifact-review-turn-${suffix}`
  const rootTaskId = `artifact-review-root-${suffix}`
  const writerTaskId = `artifact-review-writer-${suffix}`
  const reviewerTaskId = `artifact-review-reviewer-${suffix}`
  const jobId = `artifact-review-job-${suffix}`
  const leaseExpiresAt = new Date(Date.now() + 10 * 60_000)
  const context = JSON.stringify({ selectedJobPreparation: { jobId } })

  await testPool!.query(`INSERT INTO "User" ("id") VALUES ($1)`, [userId])
  await testPool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "score", "url", "source", "salary", "description", "keywords")
    VALUES ($1, $2, 'Fixture Co', 'Engineer', 'Dublin', 'saved', 8, 'https://example.test/job', 'greenhouse', NULL, 'Original selected source', 'TypeScript')`, [jobId, userId])
  await testPool!.query(`INSERT INTO "Resume" ("id", "userId", "name", "kind", "origin", "isDefault", "content")
    VALUES ($1, $2, 'Base resume', 'base', 'upload', true, '{"skills":["TypeScript"]}'::jsonb)`, [`resume-${suffix}`, userId])
  await testPool!.query(`INSERT INTO persona_facts ("id", "userId", "key", "category", "value", "source", "source_ref", "confidence", "allowedUses", "status")
    VALUES ($1, $2, 'skill', 'experience', 'TypeScript', 'user', 'resume', 1, ARRAY['cover_letter'], 'confirmed')`, [`persona-${suffix}`, userId])
  const sourceDigest = (await loadSelectedJobArtifactContext(testPool!, userId, jobId)).preparation.sourceDigest

  await testPool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "status") VALUES ($1, $2, 'running')`, [sessionId, userId])
  await testPool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "rootTaskId", "status") VALUES ($1, $2, $3, $4, 'waiting')`, [turnId, sessionId, userId, rootTaskId])
  await testPool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "role", "taskType", "status", "context")
    VALUES ($1, $2, $3, $1, NULL, 'orchestrator', 'root', 'running', $4::jsonb)`, [rootTaskId, sessionId, turnId, context])
  for (const [taskId, role, taskType] of [
    [writerTaskId, "writer", "cover_letter_draft"],
    [reviewerTaskId, "reviewer", "cover_letter_review"],
  ] as const) {
    const leaseOwner = `owner-${taskId}`
    await testPool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "role", "taskType", "status", "leaseOwner", "leaseExpiresAt", "attemptCount", "interruptRequestedAt", "context")
      VALUES ($1, $2, $3, $4, $4, $5, $6, 'running', $7, $8, 1, NULL, $9::jsonb)`, [taskId, sessionId, turnId, rootTaskId, role, taskType, leaseOwner, leaseExpiresAt, context])
  }

  const writerFence: AgentArtifactTaskFence = { taskId: writerTaskId, userId, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, leaseOwner: `owner-${writerTaskId}`, attemptCount: 1 }
  const reviewerFence: AgentArtifactTaskFence = { taskId: reviewerTaskId, userId, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, leaseOwner: `owner-${reviewerTaskId}`, attemptCount: 1 }
  const baseId = `cover-letter-base-${suffix}`
  const base = await store!.registerBase({ id: baseId, userId, jobId, type: "cover_letter", content: { text: "Source-backed base" } })
  const scope: ArtifactToolScope = {
    userId, sessionId, jobId, sourceDigest, evidenceRefs: [`job:${jobId}`], taskId: writerTaskId,
    toolCallId: `draft-initial-${suffix}`, taskFence: writerFence,
  }
  const draft = await store!.writeDraft(scope, {
    baseArtifactId: base.id, baseHash: base.hash, content: "First draft", constraints: {},
    requestHash: hashArtifactContent(`initial-${suffix}`),
  })
  const reviewHash = hashArtifactContent(`review-${suffix}`)
  await store!.saveReview({
    userId, sessionId, jobId, artifactId: draft.artifactId, version: draft.version, contentHash: draft.contentHash,
    sourceDigest, currentSourceDigest: sourceDigest, status: "needs_revision", findings: [{ id: "clarity", message: "Revise the opening" }],
    evidenceRefs: [`job:${jobId}`], taskId: reviewerTaskId, toolCallId: `review-${suffix}`,
    requestHash: hashArtifactContent(`review-request-${suffix}`), reviewHash, taskFence: reviewerFence,
  })
  const artifactRef: ArtifactVersionRef = {
    artifactId: draft.artifactId, version: draft.version, contentHash: draft.contentHash, sourceDigest: draft.sourceDigest,
  }
  return {
    userId, sessionId, turnId, rootTaskId, writerTaskId, reviewerTaskId, jobId, sourceDigest,
    writerFence, reviewerFence, scope, artifactRef,
    revision: { dependencyTaskId: reviewerTaskId, artifactRef, currentSourceDigest: sourceDigest, reviewHash },
    baseId: base.id, baseHash: base.hash,
  }
}

type CorrectionDraftReceiptFixture = Readonly<{
  readonly callId: string
  readonly input: ArtifactToolDraftInput
  readonly version: Awaited<ReturnType<PgArtifactToolStore["writeDraft"]>>
  readonly artifactRef: ArtifactVersionRef
}>

async function createCorrectionDraftReceipt(fixture: Fixture, options: {
  readonly result?: "completed" | "failed" | "missing"
  readonly wrongOutput?: boolean
} = {}): Promise<CorrectionDraftReceiptFixture> {
  const callId = `correction-draft-${randomUUID()}`
  const input = {
    baseArtifactId: fixture.baseId,
    baseHash: fixture.baseHash,
    content: "Corrected draft after exact review feedback",
    constraints: {},
    expectedPreviousVersion: fixture.artifactRef.version,
    expectedPreviousHash: fixture.artifactRef.contentHash,
  }
  const scope = { ...fixture.scope, toolCallId: callId }
  const version = await store!.writeDraft(scope, { ...input, requestHash: hashArtifactContent({ callId, input }) })
  const artifactRef: ArtifactVersionRef = {
    artifactId: version.artifactId, version: version.version, contentHash: version.contentHash, sourceDigest: version.sourceDigest,
  }
  const persistedInput = {
    baseArtifactId: input.baseArtifactId, baseHash: input.baseHash,
  }
  const stepId = `task:${fixture.writerTaskId}:step:0:attempt:1`
  const callItemId = `task:${fixture.writerTaskId}:item:tool-call:${callId}:attempt:1`
  const resultItemId = `task:${fixture.writerTaskId}:item:tool-result:${callId}:attempt:1`
  await testPool!.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status")
    VALUES ($1, $2, $3, $4, 0, 1, 'completed')`, [stepId, fixture.sessionId, fixture.turnId, fixture.writerTaskId])
  await testPool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    callItemId, fixture.sessionId, fixture.turnId, stepId, fixture.writerTaskId,
    JSON.stringify({ toolCallId: callId, toolName: "cover_letter.draft", toolVersion: "1", status: "completed", errorCode: null, input: persistedInput }),
  ])
  if (options.result !== "missing") {
    const output = options.wrongOutput ? { artifactRef: { ...artifactRef, version: artifactRef.version + 1 } } : { artifactRef }
    await testPool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'tool_result', $6, NULL, 1, $7::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
      resultItemId, fixture.sessionId, fixture.turnId, stepId, fixture.writerTaskId,
      options.result === "failed" ? "failed" : "completed",
      JSON.stringify({ toolCallId: callId, output: options.result === "failed" ? null : output, errorCode: options.result === "failed" ? "tool_execution_failed" : null }),
    ])
  }
  return { callId, input, version, artifactRef }
}

async function resumeWriterFence(fixture: Fixture): Promise<ArtifactToolScope> {
  const leaseOwner = `writer-reclaimed-${randomUUID()}`
  await testPool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $2, "attemptCount" = 2,
      "leaseExpiresAt" = clock_timestamp() + interval '10 minutes' WHERE "id" = $1`, [fixture.writerTaskId, leaseOwner])
  return { ...fixture.scope, toolCallId: "writer-review-feedback", taskFence: { ...fixture.writerFence, leaseOwner, attemptCount: 2 } }
}

describeWithPostgres("Writer review feedback persistence on disposable PostgreSQL", () => {
  beforeAll(async () => {
    testPool = scopedPool(admin!)
    store = new PgArtifactToolStore(testPool, readSelectedJobSourceDigestWithClient)
    await admin!.query(`CREATE SCHEMA "${schema}"`)
    const ddl = [
      `CREATE TABLE "User" ("id" text PRIMARY KEY)` ,
      `CREATE TABLE "Job" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "company" text NOT NULL, "role" text NOT NULL,
        "location" text, "status" text NOT NULL, "score" double precision, "url" text, "source" text,
        "salary" text, "description" text, "keywords" text, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE "Resume" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "name" text NOT NULL, "kind" text NOT NULL,
        "origin" text NOT NULL, "isDefault" boolean NOT NULL DEFAULT false, "content" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE persona_facts (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "key" text NOT NULL, "category" text NOT NULL,
        "value" text NOT NULL, "source" text NOT NULL, "source_ref" text, "confidence" double precision NOT NULL,
        "allowedUses" text[] NOT NULL, "status" text NOT NULL, "expires_at" timestamptz,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE "agent_sessions" ("id" text PRIMARY KEY, "userId" text NOT NULL, "status" text NOT NULL, UNIQUE ("id", "userId"))`,
      `CREATE TABLE "agent_turns" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "userId" text NOT NULL, "rootTaskId" text NOT NULL,
        "status" text NOT NULL, "leaseOwnerId" text, "leaseVersion" integer NOT NULL DEFAULT 0, "leaseExpiresAt" timestamptz
      )`,
      `CREATE TABLE "sub_agent_tasks" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "turnId" text NOT NULL, "rootTaskId" text NOT NULL,
        "parentTaskId" text, "role" text NOT NULL, "taskType" text NOT NULL, "status" text NOT NULL,
        "leaseOwner" text, "leaseExpiresAt" timestamptz,
        "attemptCount" integer NOT NULL DEFAULT 1, "interruptRequestedAt" timestamptz, "context" jsonb NOT NULL,
        "absoluteDeadlineAt" TIMESTAMP(3), "leaseSegmentStartedAt" TIMESTAMP(3)
      )`,
      `CREATE TABLE "agent_steps" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "turnId" text NOT NULL, "taskId" text NOT NULL,
        "ordinal" integer NOT NULL, "attempt" integer NOT NULL, "status" text NOT NULL
      )`,
      `CREATE TABLE "agent_items" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "turnId" text NOT NULL, "stepId" text,
        "taskId" text, "type" text NOT NULL, "status" text NOT NULL, "phase" text, "revision" integer NOT NULL DEFAULT 0,
        "content" jsonb NOT NULL, "startedAt" timestamptz, "completedAt" timestamptz, "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE "agent_artifact" (
        "id" text PRIMARY KEY, "userId" text NOT NULL, "jobId" text NOT NULL, "artifactType" text NOT NULL,
        "lifecycle" text NOT NULL, "baseId" text, "baseHash" text, "content" jsonb NOT NULL, "hash" text NOT NULL,
        "constraintHash" text NOT NULL, "provenanceRefs" text[] NOT NULL DEFAULT '{}', "evidenceRefs" text[] NOT NULL DEFAULT '{}',
        "previousHash" text, "version" integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("id", "userId", "jobId")
      )`,
      `CREATE UNIQUE INDEX "artifact_review_842_scope_key" ON "agent_artifact" ("userId", "jobId", "lifecycle", "artifactType")`,
      `CREATE TABLE "agent_artifact_version" (
        "id" text PRIMARY KEY, "artifactId" text NOT NULL, "version" integer NOT NULL, "userId" text NOT NULL,
        "sessionId" text NOT NULL, "jobId" text NOT NULL, "artifactType" text NOT NULL, "content" jsonb NOT NULL,
        "contentHash" text NOT NULL, "sourceDigest" text NOT NULL, "constraintHash" text NOT NULL,
        "provenanceRefs" text[] NOT NULL DEFAULT '{}', "evidenceRefs" text[] NOT NULL DEFAULT '{}', "baseId" text NOT NULL,
        "baseHash" text NOT NULL, "previousHash" text, "taskId" text NOT NULL, "toolCallId" text NOT NULL,
        "requestHash" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("artifactId", "version"),
        UNIQUE ("taskId", "toolCallId")
      )`,
      `CREATE TABLE "agent_artifact_review" (
        "id" text PRIMARY KEY, "artifactVersionId" text NOT NULL, "userId" text NOT NULL, "sessionId" text NOT NULL,
        "jobId" text NOT NULL, "artifactId" text NOT NULL, "version" integer NOT NULL, "contentHash" text NOT NULL,
        "sourceDigest" text NOT NULL, "currentSourceDigest" text NOT NULL, "status" text NOT NULL,
        "findings" jsonb NOT NULL DEFAULT '[]'::jsonb, "evidenceRefs" text[] NOT NULL DEFAULT '{}',
        "taskId" text NOT NULL, "toolCallId" text NOT NULL, "requestHash" text NOT NULL, "reviewHash" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("taskId", "toolCallId")
      )`,
    ]
    for (const statement of ddl) await testPool.query(statement)
  })

  afterAll(async () => {
    try {
      if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin?.end()
    }
  })

  it("returns only the exact current needs-revision receipt to its live Writer fence", async () => {
    const fixture = await createFixture()
    const exact = await store!.readRevisionReview(fixture.scope, fixture.revision)
    expect(exact).toMatchObject({
      taskId: fixture.reviewerTaskId, reviewHash: fixture.revision.reviewHash, status: "needs_revision",
      artifactId: fixture.artifactRef.artifactId, version: fixture.artifactRef.version,
      contentHash: fixture.artifactRef.contentHash, sourceDigest: fixture.sourceDigest, currentSourceDigest: fixture.sourceDigest,
    })
    expect(exact?.findings).toEqual([{ id: "clarity", message: "Revise the opening" }])

    await expect(store!.readRevisionReview(fixture.scope, { ...fixture.revision, dependencyTaskId: `wrong-reviewer-${randomUUID()}` })).resolves.toBeNull()
    await expect(store!.readRevisionReview(fixture.scope, { ...fixture.revision, reviewHash: hashArtifactContent("wrong review") })).resolves.toBeNull()
    await expect(store!.readRevisionReview(fixture.scope, {
      ...fixture.revision, currentSourceDigest: hashArtifactContent("drifted source"),
    })).resolves.toBeNull()

    await expect(store!.readRevisionReview({ ...fixture.scope, userId: `wrong-${fixture.userId}` }, fixture.revision)).resolves.toBeNull()
    await expect(store!.readRevisionReview({ ...fixture.scope, sessionId: `wrong-${fixture.sessionId}` }, fixture.revision)).resolves.toBeNull()
    await expect(store!.readRevisionReview({ ...fixture.scope, jobId: `wrong-${fixture.jobId}` }, fixture.revision)).resolves.toBeNull()
    await expect(store!.readRevisionReview({ ...fixture.scope, taskFence: { ...fixture.writerFence, taskId: `wrong-task-${randomUUID()}` } }, fixture.revision)).resolves.toBeNull()

    await testPool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = $1`, [fixture.writerTaskId])
    await expect(store!.readRevisionReview(fixture.scope, fixture.revision)).resolves.toBeNull()
    await testPool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $2, "attemptCount" = 2, "leaseExpiresAt" = clock_timestamp() + interval '10 minutes' WHERE "id" = $1`, [fixture.writerTaskId, `reclaimed-${randomUUID()}`])
    await expect(store!.readRevisionReview(fixture.scope, fixture.revision)).resolves.toBeNull()
  })

  it("resumes an exact committed correction draft receipt under the next Writer lease without another version", async () => {
    const fixture = await createFixture()
    const receipt = await createCorrectionDraftReceipt(fixture)
    const retryScope = await resumeWriterFence(fixture)

    const review = await store!.readRevisionReview(retryScope, fixture.revision)
    expect(review).toMatchObject({
      taskId: fixture.reviewerTaskId, reviewHash: fixture.revision.reviewHash, status: "needs_revision",
      artifactId: fixture.artifactRef.artifactId, version: fixture.artifactRef.version,
      contentHash: fixture.artifactRef.contentHash, sourceDigest: fixture.sourceDigest, currentSourceDigest: fixture.sourceDigest,
    })
    const callItem = await testPool!.query<{ input: Record<string, unknown> }>(`SELECT "content"->'input' AS "input" FROM "agent_items" WHERE "id" = $1`, [
      `task:${fixture.writerTaskId}:item:tool-call:${receipt.callId}:attempt:1`,
    ])
    expect(callItem.rows[0]?.input).toEqual({
      baseArtifactId: fixture.baseId, baseHash: fixture.baseHash,
    })

    const replayed = await store!.writeDraft({ ...retryScope, toolCallId: receipt.callId }, {
      ...receipt.input, requestHash: hashArtifactContent({ callId: receipt.callId, input: receipt.input }),
    })
    expect(replayed).toMatchObject({ id: receipt.version.id, version: receipt.version.version, contentHash: receipt.version.contentHash,
      previousHash: fixture.artifactRef.contentHash, taskId: fixture.writerTaskId, toolCallId: receipt.callId })
    const versions = await testPool!.query<{ version: number }>(`SELECT "version" FROM "agent_artifact_version" WHERE "artifactId" = $1 ORDER BY "version"`, [receipt.artifactRef.artifactId])
    expect(versions.rows.map(row => Number(row.version))).toEqual([1, 2])
    const head = await store!.read(fixture.userId, receipt.artifactRef.artifactId)
    expect(head).toMatchObject({ lifecycle: "draft", version: 2, hash: receipt.artifactRef.contentHash })
  })

  it.each([
    ["missing tool result", { result: "missing" as const }],
    ["failed tool result", { result: "failed" as const }],
    ["result for a different artifact reference", { wrongOutput: true }],
  ])("fails closed for a correction successor with %s", async (_label, options) => {
    const fixture = await createFixture()
    await createCorrectionDraftReceipt(fixture, options)
    const retryScope = await resumeWriterFence(fixture)
    await expect(store!.readRevisionReview(retryScope, fixture.revision)).resolves.toBeNull()
  })

  it("fails closed when the correction successor was recorded for another Writer task", async () => {
    const fixture = await createFixture()
    const receipt = await createCorrectionDraftReceipt(fixture)
    await testPool!.query(`UPDATE "agent_artifact_version" SET "taskId" = $2 WHERE "id" = $1`, [receipt.version.id, `foreign-writer-${randomUUID()}`])
    const retryScope = await resumeWriterFence(fixture)
    await expect(store!.readRevisionReview(retryScope, fixture.revision)).resolves.toBeNull()
  })

  it("fails closed when selected source changes after the correction successor was committed", async () => {
    const fixture = await createFixture()
    await createCorrectionDraftReceipt(fixture)
    const retryScope = await resumeWriterFence(fixture)
    await testPool!.query(`UPDATE "Job" SET "description" = 'Changed after correction draft commit' WHERE "id" = $1`, [fixture.jobId])
    await expect(store!.readRevisionReview(retryScope, fixture.revision)).resolves.toBeNull()
  })

  it("fails closed when selected sources drift after preparation and before revision receipt lookup", async () => {
    const fixture = await createFixture()
    await testPool!.query(`UPDATE "Job" SET "description" = 'Changed after Writer preparation' WHERE "id" = $1`, [fixture.jobId])
    const drifted = await loadSelectedJobArtifactContext(testPool!, fixture.userId, fixture.jobId)
    expect(drifted.preparation.sourceDigest).not.toBe(fixture.sourceDigest)
    await expect(store!.readRevisionReview(fixture.scope, fixture.revision)).resolves.toBeNull()
  })

  it("allows only one concurrent revision to advance the reviewed version-and-hash head", async () => {
    const fixture = await createFixture()
    const attempts = ["first", "second"].map(label => store!.writeDraft(
      { ...fixture.scope, toolCallId: `revision-${label}-${randomUUID()}` },
      {
        baseArtifactId: fixture.baseId, baseHash: fixture.baseHash, content: `Revised draft ${label}`, constraints: {},
        expectedPreviousVersion: fixture.artifactRef.version, expectedPreviousHash: fixture.artifactRef.contentHash,
        requestHash: hashArtifactContent(`revision-request-${label}-${randomUUID()}`),
      },
    ))
    const results = await Promise.allSettled(attempts)
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: "precondition_failed" })

    const head = await store!.read(fixture.userId, fixture.artifactRef.artifactId)
    expect(head).toMatchObject({ lifecycle: "draft", version: 2 })
    const versions = await testPool!.query<{ version: number }>(`SELECT "version" FROM "agent_artifact_version" WHERE "artifactId" = $1 ORDER BY "version"`, [fixture.artifactRef.artifactId])
    expect(versions.rows.map(row => Number(row.version))).toEqual([1, 2])
    await expect(store!.readRevisionReview(fixture.scope, fixture.revision)).resolves.toBeNull()
  })
})
