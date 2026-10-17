import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient } from "pg"

import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import { hashArtifactContent } from "./artifact-adapters.js"
import { PgArtifactToolStore } from "../tools/artifact-store-pg.js"
import type { ArtifactToolRevisionContext, ArtifactToolScope, ArtifactVersionRef } from "../tools/artifact-tools.js"
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
  await testPool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "status", "context")
    VALUES ($1, $2, $3, $1, NULL, 'running', $4::jsonb)`, [rootTaskId, sessionId, turnId, context])
  for (const [taskId, leaseOwner] of [[writerTaskId, `owner-${writerTaskId}`], [reviewerTaskId, `owner-${reviewerTaskId}`]]) {
    await testPool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "status", "leaseOwner", "leaseExpiresAt", "attemptCount", "interruptRequestedAt", "context")
      VALUES ($1, $2, $3, $4, $4, 'running', $5, $6, 1, NULL, $7::jsonb)`, [taskId, sessionId, turnId, rootTaskId, leaseOwner, leaseExpiresAt, context])
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
      `CREATE TABLE "agent_turns" ("id" text PRIMARY KEY, "sessionId" text NOT NULL, "userId" text NOT NULL, "rootTaskId" text NOT NULL, "status" text NOT NULL)`,
      `CREATE TABLE "sub_agent_tasks" (
        "id" text PRIMARY KEY, "sessionId" text NOT NULL, "turnId" text NOT NULL, "rootTaskId" text NOT NULL,
        "parentTaskId" text, "status" text NOT NULL, "leaseOwner" text, "leaseExpiresAt" timestamptz,
        "attemptCount" integer NOT NULL DEFAULT 1, "interruptRequestedAt" timestamptz, "context" jsonb NOT NULL
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
