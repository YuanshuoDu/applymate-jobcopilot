import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool } from "pg"
import { Redis } from "ioredis"
import { ModelAdapterRegistry, type HarnessModelRequest, type ModelAdapter, type ModelStreamEvent } from "@jobcopilot/agent-model"
import type { WorkerUsageAuthorizationInput } from "../../queue/ai-usage-bridge.js"
import {
  NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
  NATIVE_VERIFICATION_PACKET_CONTEXT_KEY,
  digestNativeVerificationValue,
  parseNativeVerificationControl,
} from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"

const DATABASE_NAME = "applymate_agent_brain_ci"

function disposablePostgresUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Native brain acceptance requires the dedicated disposable PostgreSQL URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Native brain acceptance accepts only the dedicated disposable PostgreSQL URL")
  return value
}

function disposableRedisUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Native brain acceptance requires the dedicated disposable Redis URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "redis:" || url.hostname !== "127.0.0.1" || url.port !== "6379" || url.pathname !== "/15"
    || url.username || url.password || url.search || url.hash) throw new Error("Native brain acceptance accepts only disposable Redis DB 15")
  return value
}

const databaseUrl = disposablePostgresUrl()
const redisUrl = disposableRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip
const suffix = randomUUID()
const fixtureJobId = () => `c${randomUUID().replace(/-/g, "").slice(0, 24)}`
const ids = {
  user: `native-brain-user-${suffix}`, session: `native-brain-session-${suffix}`,
  turn: `native-brain-turn-${suffix}`, root: `native-brain-root-${suffix}`,
  rootStep: `native-brain-root-step-${suffix}`, turnOwner: `native-brain-turn-owner-${suffix}`,
  taskOwner: `native-brain-task-owner-${suffix}`, job: fixtureJobId(), unrelatedJob: fixtureJobId(),
}
const goal = "Answer whether the owned job description states Fact 42 is present."
const turnCriteria = ["State whether Fact 42 is present using the owned job description."]
const childGoal = "Inspect the owned job description and report whether Fact 42 is present."
const childCriteria = turnCriteria
const followupChildGoal = "Recheck the owned job description and state whether Fact 42 is present."
const unrelatedChildGoal = "Find the owned job description that confirms Harbor 9 is open."
const unrelatedChildCriteria = ["The result accurately states whether the owned job description says Harbor 9 is open."]
const ownerId = `native-brain-worker-${suffix}`
const profile = {
  provider: "fixture", model: "native-brain-deterministic", nativeTools: true, structuredOutput: true, streaming: true,
  continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
  supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
}

let pool: Pool | undefined
let redis: Redis | undefined

async function seed(): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, $3, 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user, goal])
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', $4::jsonb, $5::jsonb, '{}'::jsonb, $6::jsonb,
      $7, CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [
    ids.turn, ids.session, ids.user, JSON.stringify({ goal, content: [{ type: "text", text: goal }], successCriteria: turnCriteria }),
    JSON.stringify({ provider: "fixture", model: "native-brain-deterministic" }),
    JSON.stringify({ limits: { maxSteps: 64, maxToolCalls: 32 }, subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 64, maxAttempts: 3 } }),
    ids.turnOwner,
  ])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', $4,
      '[]'::jsonb, $5::jsonb, $6::jsonb, '{}'::jsonb, '{}'::jsonb, $7::jsonb, '{}'::jsonb,
      $8::jsonb, 1, 3, $9, CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP)`, [
    ids.root, ids.session, ids.turn, goal, JSON.stringify(turnCriteria), JSON.stringify(["jobs.search", "agent.spawn", "agent.followup"]),
    JSON.stringify({ provider: "fixture", model: "native-brain-deterministic" }),
    JSON.stringify({ limits: { maxSteps: 64, maxToolCalls: 32 }, subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 64, maxAttempts: 3 } }),
    ids.taskOwner,
  ])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, $5::jsonb)`, [
    ids.rootStep, ids.session, ids.turn, ids.root, JSON.stringify({ provider: "fixture", model: "native-brain-deterministic" }),
  ])
  await pool!.query(`INSERT INTO "Job"
    ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
    VALUES ($1, $2, 'Fact Fixture GmbH', 'Research Engineer Fact 42', 'Dublin', 'saved', 'https://jobs.example.invalid/fact-42',
      'The owned job description says Fact 42 is present.', 'fixture', CURRENT_TIMESTAMP)`, [ids.job, ids.user])
  await pool!.query(`INSERT INTO "Job"
    ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
    VALUES ($1, $2, 'Harbor Fixture GmbH', 'Harbor 9 Coordinator', 'Dublin', 'saved', 'https://jobs.example.invalid/harbor-9',
      'The owned job description says Harbor 9 is open.', 'fixture', CURRENT_TIMESTAMP)`, [ids.unrelatedJob, ids.user])
}

function reportFor(packet: NonNullable<ReturnType<typeof parseNativeVerificationPacket>>) {
  const targetText = packet.target.kind === "child" ? packet.target.resultText : packet.target.candidateText
  const requirements = packet.criteria.map(item => item.requirement)
  const expectedFact = packet.goal === childGoal && requirements.length === 1 && requirements[0] === turnCriteria[0]
    ? { phrase: "Fact 42 is present", jobId: ids.job, candidatePositive: "fact 42 is present", candidateNegative: "fact 42 is absent" }
    : packet.goal === followupChildGoal && requirements.length === 1 && requirements[0] === turnCriteria[0]
      ? { phrase: "Fact 42 is present", jobId: ids.job, candidatePositive: "fact 42 is present", candidateNegative: "fact 42 is absent" }
      : packet.goal === unrelatedChildGoal && requirements.length === 1 && requirements[0] === unrelatedChildCriteria[0]
      ? { phrase: "Harbor 9 is open", jobId: ids.unrelatedJob, candidatePositive: "harbor 9 is open", candidateNegative: "harbor 9 is closed" }
      : packet.goal === goal && requirements.length === 1 && requirements[0] === turnCriteria[0]
        ? { phrase: "Fact 42 is present", jobId: ids.job, candidatePositive: "fact 42 is present", candidateNegative: "fact 42 is absent" }
        : null
  let sourceReference: string | undefined
  let hasOwnedFact = false
  if (expectedFact && packet.target.kind === "child") {
    let targetJobIds = new Set<string>([expectedFact.jobId])
    try {
      const result = JSON.parse(targetText) as { findings?: Array<{ jobId?: unknown }>; evidence?: Array<{ ref?: unknown }> }
      for (const value of [...(result.findings ?? []).map(item => item.jobId), ...(result.evidence ?? []).map(item => item.ref)]) {
        if (typeof value === "string" && value.trim() && value.length <= 256) targetJobIds.add(value)
      }
    } catch { /* current child result may use a bounded non-JSON final text */ }
    for (const item of packet.evidence) {
      if (item.kind !== "tool_result") continue
      try {
        const row = JSON.parse(item.summary) as { tool?: unknown; status?: unknown; output?: { jobs?: Array<{ id?: unknown; description?: unknown }> } }
        const matchingJob = row.output?.jobs?.find(job => typeof job.id === "string" && targetJobIds.has(job.id)
          && typeof job.description === "string" && job.description.toLowerCase().includes(expectedFact.phrase.toLowerCase()))
        if (row.tool === "jobs.search" && row.status === "completed" && matchingJob) {
          hasOwnedFact = true
          sourceReference = item.referenceId
          break
        }
      } catch { /* malformed owned receipts cannot prove the criterion */ }
    }
  }
  let hasCurrentOwnedFact = false
  if (expectedFact && packet.target.kind === "root_goal") {
    const activeNodes = packet.evidence.flatMap(item => {
      if (item.kind !== "graph_history") return []
      try {
        const row = JSON.parse(item.summary) as { activeNative?: unknown; taskId?: unknown; status?: unknown; criteria?: unknown; persistedResult?: { summary?: unknown; finalText?: unknown; structuredResult?: { summary?: unknown } } }
        return row.activeNative === true && typeof row.taskId === "string" ? [{ item, row }] : []
      } catch { return [] }
    })
    for (const { item, row } of activeNodes) {
      const persistedSummary = typeof row.persistedResult?.summary === "string" ? row.persistedResult.summary
        : typeof row.persistedResult?.structuredResult?.summary === "string" ? row.persistedResult.structuredResult.summary
          : typeof row.persistedResult?.finalText === "string" ? row.persistedResult.finalText : ""
      if (!Array.isArray(row.criteria) || !row.criteria.includes(turnCriteria[0]) || row.status !== "completed"
        || !persistedSummary.toLowerCase().includes(expectedFact.phrase.toLowerCase())) continue
      const independentlyPassed = packet.evidence.some(evidence => {
        if (evidence.kind !== "review_history") return false
        try {
          const review = JSON.parse(evidence.summary) as { targetTaskId?: unknown; targetKind?: unknown; disposition?: unknown; criteria?: unknown }
          const reviewSummary = JSON.parse(String(review.criteria ?? "{}")) as { criteria?: Array<{ disposition?: string }> }
          return review.targetTaskId === row.taskId && review.targetKind === "child" && review.disposition === "passed"
            && reviewSummary.criteria?.length === 1 && reviewSummary.criteria[0]?.disposition === "passed"
        } catch { return false }
      })
      if (independentlyPassed) { hasCurrentOwnedFact = true; sourceReference = item.referenceId; break }
    }
  }
  const candidate = targetText.toLowerCase()
  const passed = Boolean(expectedFact && (hasOwnedFact || hasCurrentOwnedFact)
    && candidate.includes(expectedFact.candidatePositive) && !candidate.includes(expectedFact.candidateNegative))
  return {
    schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
    criteria: packet.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      disposition: passed ? "passed" as const : "failed" as const,
      reasonCode: passed ? "meets_criterion" as const : "does_not_meet_criterion" as const,
      evidenceReferenceIds: passed && sourceReference ? [sourceReference] : [packet.target.referenceId],
    })),
  }
}

type CanonicalFixture = Readonly<{ userId: string; sessionId: string; turnId: string; ownerId: string; jobId: string }>

function waitForDatabase<T>(label: string, load: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = async (): Promise<void> => {
      try {
        const value = await load()
        if (ready(value)) { resolve(value); return }
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`${label} timed out; last=${JSON.stringify(value).slice(0, 1_200)}`))
          return
        }
        setTimeout(() => { void poll() }, 50)
      } catch (error: unknown) {
        reject(error)
      }
    }
    void poll()
  })
}

async function seedCanonicalFixture(value: CanonicalFixture): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [value.userId, `${value.userId}@example.invalid`])
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, $3, 'running', 'test', CURRENT_TIMESTAMP)`, [value.sessionId, value.userId, goal])
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'queued', 'user', $4::jsonb, $5::jsonb, '{}'::jsonb, $6::jsonb, CURRENT_TIMESTAMP)`, [
    value.turnId, value.sessionId, value.userId, JSON.stringify({ goal, content: [{ type: "text", text: goal }], successCriteria: turnCriteria }),
    JSON.stringify({ provider: "fixture", model: "native-brain-deterministic" }),
    JSON.stringify({ limits: { maxSteps: 32, maxToolCalls: 12 }, subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 64, maxAttempts: 3 } }),
  ])
  await pool!.query(`INSERT INTO "Job"
    ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
    VALUES ($1, $2, 'Canonical Fact Fixture GmbH', 'Research Engineer Fact 42', 'Dublin', 'saved', 'https://jobs.example.invalid/canonical-fact-42',
      'The owned job description says Fact 42 is present.', 'fixture', CURRENT_TIMESTAMP)`, [value.jobId, value.userId])
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

describeWithServices("native brain PostgreSQL + Redis acceptance", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 8 })
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null, connectTimeout: 2_000, retryStrategy: attempt => attempt > 3 ? null : 100 })
    await redis.ping()
    vi.doMock("../../redis.js", () => ({ redisConnection: redis, redisCommandConnection: redis, closeSharedRedisConnections: async () => undefined }))
    await seed()
  }, 20_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session]).catch(() => undefined)
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user]).catch(() => undefined)
      await pool.end()
    }
    if (redis) await redis.quit().catch(() => undefined)
  })

  it("creates a PG-owned native control, judges through the accounted child loop, and rechecks the exact root candidate", async () => {
    const [{ createPgTaskGraphCommandPort }, { createPgNativeVerificationPort }, { PgSubagentTaskStore }, { AgentTreeManager }, { createProductionChildExecutor }, { runSubagentQueueJob }, { readNativeVerificationTerminalProofWithClient }] = await Promise.all([
      import("./pg-task-graph-command-port.js"), import("./pg-native-verification-port.js"), import("./pg-store.js"),
      import("./manager.js"), import("./production-child-runtime.js"), import("../../queue/subagent-pause-dispatch.js"),
      import("./native-verification-pg-readback.js"),
    ])
    const scope: TaskGraphExecutionScope = {
      userId: ids.user, sessionId: ids.session, turnId: ids.turn, rootTaskId: ids.root, parentTaskId: ids.root,
      stepId: ids.rootStep, turnLeaseOwner: ids.turnOwner, turnLeaseVersion: 1,
      parentLeaseOwner: ids.taskOwner, parentAttemptCount: 1,
    }
    const commandPort = createPgTaskGraphCommandPort(pool as never)
    const spawned = await commandPort.appendNativeCoordination!({
      scope,
      request: { kind: "spawn", idempotencyKey: `initial:${suffix}`, role: "analyst", taskType: "research",
        goal: childGoal, successCriteria: childCriteria, allowedActions: ["jobs.search"], context: { fixture: "initial-negative" } },
      outputSchemaMarker: { schemaVersion: "agent-harness.v2.subagent.result", role: "analyst" },
    })
    const usageAuthorizations: string[] = [], usageSettlements: string[] = []
    const mailboxReads: string[] = []
    const initialChildTaskId = spawned.child.taskId
    const modelRuntimeFactory = ({ task }: { task: { id: string; role: string; taskType: string; goal: string; expectedOutputSchema: unknown; context: unknown } }): ModelAdapter => {
      let round = 0
      return {
        id: `native-brain-${task.role}-${task.taskType}`, profile,
        async *stream(request) {
          round += 1
          if (task.role === "auditor" && task.taskType === "native_verification") {
            const control = parseNativeVerificationControl(task.expectedOutputSchema)
            const packet = control && parseNativeVerificationPacket(task.context, control)
            if (!packet) throw new Error("fixture expected a server-bound native control packet")
            yield { type: "text_delta", text: JSON.stringify(reportFor(packet)) }
            yield { type: "completed", finishReason: "stop" }
            return
          }
          if (round === 1) {
            if (!request.tools.some(tool => (tool as { name?: unknown }).name === "jobs.search")) throw new Error("native target child did not receive its allowed read tool")
            const unrelated = task.goal === unrelatedChildGoal
            yield { type: "tool_call_completed", callId: `native-brain-search:${task.id}`, name: "jobs.search", arguments: { target: unrelated ? "Harbor 9" : "Fact 42", location: "Dublin", limit: 10 } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          const unrelated = task.goal === unrelatedChildGoal
          const initialNegative = task.id === initialChildTaskId
          const positive = !initialNegative
          const evidenceId = `read:job:${ids.job}`
          const result = {
            schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed",
            findings: [{ jobId: unrelated ? ids.unrelatedJob : ids.job, score: 8, evidenceIds: [evidenceId] }],
            evidence: [{ id: evidenceId, kind: "job", ref: unrelated ? ids.unrelatedJob : ids.job, source: "fixture" }],
            summary: unrelated ? "The saved Harbor Fixture job confirms Harbor 9 is open."
              : positive ? "Fact 42 is present in the saved job description."
                : "The owned job description says Fact 42 is absent.",
          }
          yield { type: "text_delta", text: JSON.stringify(result) }
          yield { type: "completed", finishReason: "stop" }
        },
      }
    }
    const authorizeUsage = async (input: WorkerUsageAuthorizationInput) => {
      const taskId = input.executionOwner?.kind === "task" ? input.executionOwner.taskId : "turn"
      usageAuthorizations.push(`${taskId}:${input.featureKey}`)
      return { settle: async () => { usageSettlements.push(taskId) } }
    }
    const executor = createProductionChildExecutor({
      pool: pool!, authorizeUsage, modelRuntimeFactory,
      mailboxReader: { listPendingMessages: async input => { mailboxReads.push(input.toTaskId); return [] } },
    })
    const manager = new AgentTreeManager(new PgSubagentTaskStore(pool!))
    const executeTask = async (taskId: string) => runSubagentQueueJob(pool as never, manager, executor, {
      taskId, sessionId: ids.session, rootTaskId: ids.root, ownerId: `native-brain-child-${randomUUID()}`,
    })

    const initialChild = await executeTask(spawned.child.taskId)
    const initialTask = await pool!.query<{ attemptCount: number; result: unknown; failureReason: string | null }>(
      `SELECT "attemptCount", "result", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1`, [spawned.child.taskId])
    const failureReason = initialTask.rows[0]?.failureReason
    const boundedFailureReason = typeof failureReason === "string" ? failureReason.slice(0, 240) : failureReason
    const [failureSteps, failureItems, failureEvents] = await Promise.all([
      pool!.query<{ ordinal: number; attempt: number; status: string; finishReason: string | null; errorCode: string | null }>(
        `SELECT "ordinal", "attempt", "status", "finishReason", "errorCode" FROM "agent_steps"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "ordinal" DESC LIMIT 4`,
        [ids.session, ids.turn, spawned.child.taskId]),
      pool!.query<{ type: string; phase: string | null; toolName: string | null; status: string | null; errorCode: string | null }>(
        `SELECT "type", "phase", "content"->>'toolName' AS "toolName", "content"->>'status' AS "status", "content"->>'errorCode' AS "errorCode"
         FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
         ORDER BY "createdAt" DESC LIMIT 8`, [ids.session, ids.turn, spawned.child.taskId]),
      pool!.query<{ type: string; status: string | null; errorCode: string | null; code: string | null }>(
        `SELECT "type", "payload"->>'status' AS "status", "payload"->>'errorCode' AS "errorCode", "payload"->>'code' AS "code"
         FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
         ORDER BY "sequence" DESC LIMIT 8`, [ids.session, ids.turn, spawned.child.taskId]),
    ])
    const failureDiagnostics = JSON.stringify({
      steps: failureSteps.rows.map(row => ({ ...row, ordinal: Number(row.ordinal), attempt: Number(row.attempt) })),
      items: failureItems.rows, events: failureEvents.rows,
    }).slice(0, 1_200)
    expect({ status: initialChild.status, failureReason: boundedFailureReason },
      `Initial native child did not complete; persisted failureReason=${JSON.stringify(boundedFailureReason)}; records=${failureDiagnostics}`)
      .toEqual({ status: "completed", failureReason: null })
    expect(initialTask.rows[0]?.attemptCount).toBe(1)
    expect(JSON.stringify(initialTask.rows[0]?.result)).toContain("Fact 42 is absent")
    const targetToolRows = await pool!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items" AS result
      JOIN "agent_items" AS call_item ON call_item."sessionId" = result."sessionId" AND call_item."turnId" = result."turnId"
        AND call_item."taskId" = result."taskId" AND call_item."stepId" = result."stepId"
        AND call_item."content"->>'toolCallId' = result."content"->>'toolCallId'
      WHERE result."sessionId" = $1 AND result."turnId" = $2 AND result."taskId" = $3 AND result."type" = 'tool_result'
        AND call_item."type" = 'tool_call' AND call_item."content"->>'toolName' = 'jobs.search'
        AND call_item."content"->>'status' = 'completed' AND call_item."content"->'input'->>'target' = 'Fact 42'`,
    [ids.session, ids.turn, spawned.child.taskId])
    expect(targetToolRows.rows[0]?.count).toBe(1)

    const port = createPgNativeVerificationPort(pool as never)
    const firstRequest = await port.ensureChildren(scope)
    expect(firstRequest.status).toBe("pending")
    expect(firstRequest.controlTaskIds).toHaveLength(1)
    const firstControlId = firstRequest.controlTaskIds[0]!
    const beforeFirstControlMailboxReads = mailboxReads.length
    const firstJudgment = await executeTask(firstControlId)
    expect(firstJudgment.status).toBe("completed")
    expect(mailboxReads).toHaveLength(beforeFirstControlMailboxReads)
    const firstEvaluation = await port.ensureChildren(scope)
    expect(firstEvaluation.status).toBe("failed")
    const firstReportTask = await pool!.query<{ status: string; attemptCount: number; result: Record<string, unknown>; allowedActions: unknown }>(
      `SELECT "status", "attemptCount", "result", "allowedActions" FROM "sub_agent_tasks" WHERE "id" = $1`, [firstControlId])
    const firstReport = firstReportTask.rows[0]?.result?.nativeVerificationReport as Record<string, unknown> | undefined
    expect(firstReport).toMatchObject({ disposition: "failed", controlTaskId: firstControlId, controlAttempt: 1 })
    expect(firstReportTask.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, allowedActions: [] })
    const controlItems = await pool!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_call'`, [ids.session, ids.turn, firstControlId])
    expect(controlItems.rows[0]?.count).toBe(0)

    const followup = await commandPort.appendNativeCoordination!({
      scope, request: { kind: "followup", idempotencyKey: `followup:${suffix}`, sourceTaskId: spawned.child.taskId,
        goal: followupChildGoal, successCriteria: childCriteria },
    })
    expect(followup.source).toMatchObject({ taskId: spawned.child.taskId, status: "completed", attemptCount: 1 })
    const successor = await executeTask(followup.child.taskId)
    expect(successor.status).toBe("completed")
    const graph = await commandPort.readCurrent(scope)
    expect(graph.nodes.map(node => node.native?.operationKind)).toEqual(["spawn", "followup"])
    expect(graph.nodes[1]?.native?.source?.taskId).toBe(spawned.child.taskId)

    const secondRequest = await port.ensureChildren(scope)
    expect(secondRequest.status).toBe("pending")
    expect(secondRequest.controlTaskIds).toHaveLength(1)
    const secondControlId = secondRequest.controlTaskIds[0]!
    const beforeSecondControlMailboxReads = mailboxReads.length
    expect((await executeTask(secondControlId)).status).toBe("completed")
    expect(mailboxReads).toHaveLength(beforeSecondControlMailboxReads)
    expect((await port.ensureChildren(scope)).status).toBe("passed")
    const successorResult = await pool!.query<{ result: unknown }>(`SELECT "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [followup.child.taskId])
    expect(JSON.stringify(successorResult.rows[0]?.result)).toContain("Fact 42 is present")

    const unrelatedFollowup = await commandPort.appendNativeCoordination!({
      scope, request: { kind: "followup", idempotencyKey: `unrelated-followup:${suffix}`, sourceTaskId: followup.child.taskId,
        goal: unrelatedChildGoal, successCriteria: unrelatedChildCriteria },
    })
    expect((await executeTask(unrelatedFollowup.child.taskId)).status).toBe("completed")
    const unrelatedRequest = await port.ensureChildren(scope)
    expect(unrelatedRequest.status).toBe("pending")
    expect(unrelatedRequest.pendingControlTaskIds).toHaveLength(1)
    expect((await executeTask(unrelatedRequest.pendingControlTaskIds[0]!)).status).toBe("completed")
    expect((await port.ensureChildren(scope)).status).toBe("passed")
    const unrelatedResult = await pool!.query<{ result: unknown }>(`SELECT "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [unrelatedFollowup.child.taskId])
    expect(JSON.stringify(unrelatedResult.rows[0]?.result)).toContain("Harbor 9 is open")

    const unrelatedCandidate = "Fact 42 is present in the owned job description."
    const unrelatedRoot = await port.ensureRootGoal({ scope, candidateText: unrelatedCandidate })
    expect(unrelatedRoot.status).toBe("pending")
    expect(unrelatedRoot.pendingControlTaskIds).toHaveLength(1)
    const unrelatedRootControlId = unrelatedRoot.pendingControlTaskIds[0]!
    expect((await executeTask(unrelatedRootControlId)).status).toBe("completed")
    expect((await port.ensureRootGoal({ scope, candidateText: unrelatedCandidate })).status).toBe("failed")

    const finalFollowup = await commandPort.appendNativeCoordination!({
      scope, request: { kind: "followup", idempotencyKey: `fact-followup:${suffix}`, sourceTaskId: unrelatedFollowup.child.taskId,
        goal: childGoal, successCriteria: childCriteria },
    })
    expect((await executeTask(finalFollowup.child.taskId)).status).toBe("completed")
    const finalRequest = await port.ensureChildren(scope)
    expect(finalRequest.status).toBe("pending")
    expect((await executeTask(finalRequest.pendingControlTaskIds[0]!)).status).toBe("completed")
    expect((await port.ensureChildren(scope)).status).toBe("passed")

    const rejectedCandidate = "The owned job description says Fact 42 is absent."
    const rejectedRoot = await port.ensureRootGoal({ scope, candidateText: rejectedCandidate })
    expect(rejectedRoot.status).toBe("pending")
    const rejectedControlId = rejectedRoot.pendingControlTaskIds[0]!
    expect((await executeTask(rejectedControlId)).status).toBe("completed")
    expect((await port.ensureRootGoal({ scope, candidateText: rejectedCandidate })).status).toBe("failed")

    const acceptedCandidate = "Fact 42 is present in the owned job description."
    const acceptedRoot = await port.ensureRootGoal({ scope, candidateText: acceptedCandidate })
    expect(acceptedRoot.status).toBe("pending")
    const acceptedControlId = acceptedRoot.pendingControlTaskIds[0]!
    expect((await executeTask(acceptedControlId)).status).toBe("completed")
    const passedRoot = await port.ensureRootGoal({ scope, candidateText: acceptedCandidate })
    expect(passedRoot.status).toBe("passed")
    const recovered = await port.readRecoverableGoal(scope)
    expect(recovered).toMatchObject({ status: "passed", candidateText: acceptedCandidate })
    if (!recovered || recovered.status !== "passed" || !recovered.witness) throw new Error("native root candidate was not recoverable")

    const client = await pool!.connect()
    try {
      await client.query("BEGIN")
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
      await expect(readNativeVerificationTerminalProofWithClient(client, {
        scope, candidateText: acceptedCandidate, witness: recovered.witness,
      })).resolves.toBe(true)
      await expect(readNativeVerificationTerminalProofWithClient(client, {
        scope, candidateText: `${acceptedCandidate} altered`, witness: recovered.witness,
      })).resolves.toBe(false)
      await client.query("ROLLBACK")
    } finally { client.release() }

    const reservations = await pool!.query<{ status: string; taskId: string; count: number }>(`SELECT "taskId", "status", COUNT(*)::int AS "count"
      FROM "agent_tree_budget_reservations" WHERE "sessionId" = $1 AND "turnId" = $2 GROUP BY "taskId", "status" ORDER BY "taskId", "status"`,
    [ids.session, ids.turn])
    expect(reservations.rows.length).toBeGreaterThanOrEqual(6)
    expect(reservations.rows.every(row => row.status === "consumed")).toBe(true)
    expect(usageAuthorizations.length).toBeGreaterThanOrEqual(6)
    expect(usageSettlements).toHaveLength(usageAuthorizations.length)
    expect(reservations.rows.some(row => row.taskId === firstControlId)).toBe(true)
    expect(reservations.rows.some(row => row.taskId === acceptedControlId)).toBe(true)

    const publicRows = await pool!.query<{ value: unknown }>(`SELECT item."content" AS "value" FROM "agent_items" AS item
      WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."type" = 'task_graph'
      UNION ALL
      SELECT item."content" AS "value" FROM "agent_items" AS item JOIN "sub_agent_tasks" AS control ON control."id" = item."taskId"
      WHERE item."sessionId" = $1 AND item."turnId" = $2 AND control."role" = 'auditor' AND control."taskType" = 'native_verification'
      UNION ALL
      SELECT event."payload" AS "value" FROM "agent_events" AS event JOIN "sub_agent_tasks" AS control ON control."id" = event."taskId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND control."role" = 'auditor' AND control."taskType" = 'native_verification'`, [ids.session, ids.turn])
    const serializedPublicRows = JSON.stringify(publicRows.rows)
    expect(serializedPublicRows).not.toContain(NATIVE_VERIFICATION_PACKET_CONTEXT_KEY)
    expect(serializedPublicRows).not.toContain(NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA)
    expect(serializedPublicRows).not.toContain("nativeVerificationReport")
    const requestEvents = await pool!.query<{ payload: Record<string, unknown> }>(`SELECT "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "type" = 'native_verification.requested'`, [ids.session])
    expect(requestEvents.rows.length).toBeGreaterThanOrEqual(4)
    expect(requestEvents.rows.every(row => !JSON.stringify(row.payload).includes(NATIVE_VERIFICATION_PACKET_CONTEXT_KEY)
      && !JSON.stringify(row.payload).includes(NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA))).toBe(true)
    expect(digestNativeVerificationValue(acceptedCandidate)).toMatch(/^[a-f0-9]{64}$/)
    await manager.shutdown()
  }, 120_000)

  it("runs the default canonical brain through BullMQ wait, verifier restart, and exact atomic final publication", async () => {
    const canonicalSuffix = randomUUID()
    const canonical: CanonicalFixture = {
      userId: `native-canonical-user-${canonicalSuffix}`, sessionId: `native-canonical-session-${canonicalSuffix}`,
      turnId: `native-canonical-turn-${canonicalSuffix}`, ownerId: `native-canonical-worker-${canonicalSuffix}`,
      jobId: fixtureJobId(),
    }
    await seedCanonicalFixture(canonical)

    const previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = databaseUrl!
    const [
      { createCanonicalTurnRuntime }, { createPgTaskGraphCommandPort }, { TASK_GRAPH_TEMPLATES },
      { createProductionWorkerBootstrap }, { createProductionChildExecutor }, { enqueueTurn },
      { closePool }, { persistedFinalCandidate },
    ] = await Promise.all([
      import("../canonical-turn-runtime.js"), import("./pg-task-graph-command-port.js"), import("./task-graph-templates.js"),
      import("../../queue/production-bootstrap.js"), import("./production-child-runtime.js"), import("../turns/turn-queue.js"),
      import("../../db/apply-results.js"), import("../turns/turn-execution-final-candidate.js"),
    ])

    const acceptedCandidate = "Fact 42 is present in the owned job description."
    const rejectedCandidate = "The owned job description says Fact 42 is absent."
    const usageAuthorizations: WorkerUsageAuthorizationInput[] = []
    const usageSettlements: Array<{ inputTokens: number; outputTokens: number; estimatedCostUsd: number }> = []
    const authorizeUsage = async (input: WorkerUsageAuthorizationInput) => {
      usageAuthorizations.push(input)
      return { settle: async (settlement: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }) => {
        usageSettlements.push(settlement)
      } }
    }
    let rootModelStreams = 0
    const rootRequestDiagnostics: Array<Readonly<{
      call: number; rejectedControlFound: boolean; systemMessages: number
      sameTurnPrefix: boolean; resumePrefix: boolean; targetMatch: boolean; failedCriterion: boolean; exactFeedbackRoles: string[]
    }>> = []
    let acceptedCandidateReady!: () => void
    let releaseAcceptedCandidate!: () => void
    const acceptedCandidateEntered = new Promise<void>(resolve => { acceptedCandidateReady = resolve })
    const acceptedCandidateRelease = new Promise<void>(resolve => { releaseAcceptedCandidate = resolve })
    const emitUsage = (): ModelStreamEvent => ({
      type: "usage", inputTokens: 11, outputTokens: 5, estimatedCostUsd: 0.003,
      provider: "fixture", model: "native-brain-deterministic",
    })
    const rootAdapter: ModelAdapter = {
      id: `native-canonical-root-${canonicalSuffix}`, profile,
      async *stream(request: HarnessModelRequest) {
        rootModelStreams += 1
        const call = rootModelStreams
        yield emitUsage()
        const toolNames = request.tools.map(tool => (tool as { name?: unknown }).name)
        if (call === 1) {
          expect(toolNames).toContain("agent.spawn")
          yield { type: "tool_call_completed", callId: `canonical-spawn:${canonicalSuffix}`, name: "agent.spawn", arguments: {
            idempotencyKey: `canonical-spawn:${canonicalSuffix}`, role: "analyst", taskType: "research",
            goal: childGoal, successCriteria: turnCriteria, allowedActions: ["jobs.search"], context: { fixture: "canonical-default-path" },
          } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        if (call === 2) {
          expect(toolNames).toContain("agent.wait")
          const root = await waitForDatabase("canonical root task", async () => (await pool!.query<{ rootTaskId: string | null }>(
            `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`, [canonical.turnId, canonical.sessionId])).rows[0]?.rootTaskId,
          value => typeof value === "string")
          const targetId = await waitForDatabase("canonical spawned target", async () => (await pool!.query<{ id: string }>(
            `SELECT "id" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3
              AND "role" = 'analyst' AND "taskType" = 'research' AND "goal" = $4 ORDER BY "createdAt" LIMIT 1`,
            [canonical.sessionId, canonical.turnId, root, childGoal])).rows[0]?.id, value => typeof value === "string")
          yield { type: "tool_call_completed", callId: `canonical-wait-target:${canonicalSuffix}`, name: "agent.wait", arguments: {
            idempotencyKey: `canonical-wait-target:${canonicalSuffix}`, taskIds: [targetId], mode: "all", timeoutMs: 30_000,
          } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        if (call === 3) {
          expect(toolNames).toContain("jobs.search")
          yield { type: "tool_call_completed", callId: `canonical-search:${canonicalSuffix}`, name: "jobs.search", arguments: {
            target: "Fact 42", location: "Dublin", limit: 10,
          } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        if (call >= 4) {
          const rejectedCandidateDigest = digestNativeVerificationValue(rejectedCandidate)
          const rejectedControl = await pool!.query<{ id: string }>(`SELECT "id" FROM "sub_agent_tasks"
            WHERE "sessionId" = $1 AND "turnId" = $2 AND "role" = 'auditor' AND "taskType" = 'native_verification'
              AND "expectedOutputSchema"->'target'->>'kind' = 'root_goal'
              AND "expectedOutputSchema"->'target'->>'candidateDigest' = $3
              AND "result"->'nativeVerificationReport'->>'disposition' = 'failed' LIMIT 1`,
          [canonical.sessionId, canonical.turnId, rejectedCandidateDigest])
          const systemText = request.messages.filter(message => message.role === "system")
            .flatMap(message => message.content)
            .flatMap(part => part.type === "text" ? [part.text] : [])
          const allMessagesByRole = new Map<string, string[]>()
          for (const message of request.messages) {
            const text = message.content.flatMap(part => part.type === "text" ? [part.text] : [])
            allMessagesByRole.set(message.role, [...(allMessagesByRole.get(message.role) ?? []), ...text])
          }
          const sameTurnPrefix = "Durable TaskGraph verification blocked completion:"
          const resumePrefix = "Independent review did not accept the previous root candidate."
          const hasVerifiedFeedback = (values: readonly string[]) => values.some(value =>
            (value.includes(sameTurnPrefix) || value.includes(resumePrefix))
              && value.includes(`target=${request.metadata.taskId}`)
              && value.includes("criterion=criterion-1 status=failed reason=does_not_meet_criterion"))
          const diagnostic = {
            call, rejectedControlFound: rejectedControl.rows.length > 0,
            systemMessages: request.messages.filter(message => message.role === "system").length,
            sameTurnPrefix: systemText.some(value => value.includes(sameTurnPrefix)),
            resumePrefix: systemText.some(value => value.includes(resumePrefix)),
            targetMatch: systemText.some(value => value.includes(`target=${request.metadata.taskId}`)),
            failedCriterion: systemText.some(value => value.includes("criterion=criterion-1 status=failed reason=does_not_meet_criterion")),
            exactFeedbackRoles: [...allMessagesByRole].filter(([, values]) => hasVerifiedFeedback(values)).map(([role]) => role),
          }
          rootRequestDiagnostics.push(diagnostic)
          if (rootRequestDiagnostics.length > 8) rootRequestDiagnostics.shift()
          if (rejectedControl.rows.length === 0) {
            yield { type: "text_delta", text: rejectedCandidate }
            yield { type: "completed", finishReason: "stop" }
            return
          }
          const failedFeedback = systemText
            .find(value => hasVerifiedFeedback([value]))
          expect(failedFeedback).toBeDefined()
          expect(failedFeedback?.length).toBeLessThanOrEqual(800)
          acceptedCandidateReady()
          await acceptedCandidateRelease
          yield { type: "text_delta", text: acceptedCandidate }
          yield { type: "completed", finishReason: "stop" }
          return
        }
        throw new Error(`unexpected canonical root model call ${call}`)
      },
    }

    const childModelRuntimeFactory = ({ task }: { task: { id: string; role: string; taskType: string; goal: string; expectedOutputSchema: unknown; context: unknown } }): ModelAdapter => {
      let targetRounds = 0
      return {
        id: `native-canonical-${task.role}-${task.taskType}`, profile,
        async *stream(request: HarnessModelRequest) {
          yield emitUsage()
          if (task.role === "auditor" && task.taskType === "native_verification") {
            expect(request.tools).toHaveLength(0)
            const control = parseNativeVerificationControl(task.expectedOutputSchema)
            const packet = control && parseNativeVerificationPacket(task.context, control)
            if (!control || control.controlTaskId !== task.id || !packet) throw new Error("canonical control was not server-bound")
            yield { type: "text_delta", text: JSON.stringify(reportFor(packet)) }
            yield { type: "completed", finishReason: "stop" }
            return
          }
          targetRounds += 1
          if (targetRounds === 1) {
            expect(request.tools.map(tool => (tool as { name?: unknown }).name)).toContain("jobs.search")
            yield { type: "tool_call_completed", callId: `canonical-search:${task.id}`, name: "jobs.search", arguments: {
              target: "Fact 42", location: "Dublin", limit: 10,
            } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          const evidenceId = `evidence:${task.id}:job`
          const structured = {
            schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed",
            findings: [{ jobId: canonical.jobId, score: 8, evidenceIds: [evidenceId] }],
            evidence: [{ id: evidenceId, kind: "job", ref: canonical.jobId, source: "fixture" }],
            summary: "Fact 42 is present in the owned job description.",
          }
          yield { type: "text_delta", text: JSON.stringify(structured) }
          yield { type: "completed", finishReason: "stop" }
        },
      }
    }

    const childExecutor = createProductionChildExecutor({ pool: pool!, authorizeUsage, modelRuntimeFactory: childModelRuntimeFactory })
    const makeStack = async (generation: number) => {
      const runtime = await createCanonicalTurnRuntime(pool!, {
        workerId: `${canonical.ownerId}-${generation}`,
        productionFlags: {
          taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
          consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
        },
        taskGraphCommandPort: createPgTaskGraphCommandPort(pool!),
        taskGraphTemplates: TASK_GRAPH_TEMPLATES,
        authorizeUsage,
        modelRuntimeFactory: () => ({
          adapter: rootAdapter,
          registry: new ModelAdapterRegistry().register(rootAdapter),
          candidates: [{ target: { provider: profile.provider, model: profile.model },
            requirement: { nativeTools: true, structuredOutput: true, streaming: true }, reason: "Deterministic native-brain PG acceptance" }],
        }),
      })
      try {
        const bootstrap = await createProductionWorkerBootstrap({
          pool: pool!, runtime, ownerId: `${canonical.ownerId}-${generation}`,
          turnRecoveryIntervalMs: 50,
          waitResolver: { intervalMs: 50, batchSize: 20, ownerId: `${canonical.ownerId}-wait-${generation}` },
          subagents: { execute: childExecutor, intervalMs: 50 },
        })
        return bootstrap
      } catch (error: unknown) {
        await runtime.close().catch(() => undefined)
        throw error
      }
    }

    let bootstrap: Awaited<ReturnType<typeof makeStack>> | undefined
    try {
      bootstrap = await makeStack(1)
      if (!bootstrap.subagents) throw new Error("canonical default bootstrap omitted its actual child queue")
      await bootstrap.subagents.queue.worker.pause(true)
      await enqueueTurn(pool!, bootstrap.turns.queue, { turnId: canonical.turnId, sessionId: canonical.sessionId, ownerId: `${canonical.ownerId}-1` })
      await waitForDatabase("durable target child wait", async () => (await pool!.query<{
        turnStatus: string; childStatus: string; waitStatus: string; taskId: string
      }>(`SELECT turn."status" AS "turnStatus", child."status" AS "childStatus", wait."status" AS "waitStatus", child."id" AS "taskId"
        FROM "sub_agent_tasks" AS child JOIN "agent_turns" AS turn ON turn."id" = child."turnId" AND turn."sessionId" = child."sessionId"
        JOIN "agent_wait_conditions" AS wait ON wait."sessionId" = child."sessionId" AND wait."turnId" = child."turnId"
          AND wait."parentTaskId" = child."parentTaskId" AND wait."status" = 'waiting'
          AND wait."targetTaskIds" @> jsonb_build_array(child."id")
        WHERE child."sessionId" = $1 AND child."turnId" = $2 AND child."role" = 'analyst' AND child."goal" = $3
        ORDER BY child."createdAt" LIMIT 1`, [canonical.sessionId, canonical.turnId, childGoal])).rows[0],
      value => value?.turnStatus === "waiting_for_dependency" && value.childStatus === "queued" && value.waitStatus === "waiting")
      await bootstrap.subagents.queue.worker.resume()
      await Promise.race([acceptedCandidateEntered, delay(90_000).then(() => {
        return pool!.query<{ turnStatus: string | null; rootControls: number; failedReports: number; rejectedControls: number; rejectedFailedReports: number }>(
          `SELECT turn."status" AS "turnStatus",
             COUNT(*) FILTER (WHERE task."expectedOutputSchema"->'target'->>'kind' = 'root_goal')::int AS "rootControls",
             COUNT(*) FILTER (WHERE task."result"->'nativeVerificationReport'->>'disposition' = 'failed')::int AS "failedReports",
             COUNT(*) FILTER (WHERE task."expectedOutputSchema"->'target'->>'kind' = 'root_goal'
               AND task."expectedOutputSchema"->'target'->>'candidateDigest' = $3)::int AS "rejectedControls",
             COUNT(*) FILTER (WHERE task."expectedOutputSchema"->'target'->>'kind' = 'root_goal'
               AND task."expectedOutputSchema"->'target'->>'candidateDigest' = $3
               AND task."result"->'nativeVerificationReport'->>'disposition' = 'failed')::int AS "rejectedFailedReports"
           FROM "agent_turns" AS turn LEFT JOIN "sub_agent_tasks" AS task
             ON task."sessionId" = turn."sessionId" AND task."turnId" = turn."id"
             AND task."role" = 'auditor' AND task."taskType" = 'native_verification'
           WHERE turn."id" = $1 AND turn."sessionId" = $2 GROUP BY turn."status"`,
          [canonical.turnId, canonical.sessionId, digestNativeVerificationValue(rejectedCandidate)]).then(result => {
          const state = result.rows[0] ?? null
          throw new Error(`canonical root did not replan to the accepted candidate; modelStreams=${rootModelStreams}; requestTrace=${JSON.stringify(rootRequestDiagnostics)}; persistedState=${JSON.stringify(state)}`)
        })
      })])
      await bootstrap.subagents.queue.worker.pause(true)
      releaseAcceptedCandidate()

      const pendingRootControl = await waitForDatabase("durable accepted root-goal wait", async () => {
        const turn = (await pool!.query<{ status: string; rootTaskId: string | null }>(
          `SELECT "status", "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`,
          [canonical.turnId, canonical.sessionId])).rows[0]
        const controls = await pool!.query<{ id: string; status: string; expectedOutputSchema: unknown }>(
          `SELECT "id", "status", "expectedOutputSchema" FROM "sub_agent_tasks"
           WHERE "sessionId" = $1 AND "turnId" = $2 AND "role" = 'auditor' AND "taskType" = 'native_verification'
           ORDER BY "createdAt", "id"`, [canonical.sessionId, canonical.turnId])
        const accepted = controls.rows.find(row => {
          const control = parseNativeVerificationControl(row.expectedOutputSchema)
          return control?.target.kind === "root_goal" && control.target.candidateDigest === digestNativeVerificationValue(acceptedCandidate)
        })
        const wait = accepted && await pool!.query<{ status: string }>(
          `SELECT "status" FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2
            AND "status" = 'waiting' AND "targetTaskIds" @> jsonb_build_array($3::text) ORDER BY "createdAt" DESC LIMIT 1`,
          [canonical.sessionId, canonical.turnId, accepted.id])
        return { turnStatus: turn?.status, control: accepted && { id: accepted.id, status: accepted.status }, wait: wait?.rows[0]?.status }
      }, value => value.turnStatus === "waiting_for_dependency" && value.control?.status === "queued" && value.wait === "waiting")
      const rootStreamsAtCandidate = rootModelStreams
      await bootstrap.close()
      bootstrap = await makeStack(2)
      await waitForDatabase("canonical terminal Turn", async () => (await pool!.query<{ status: string; finalResponse: string | null }>(
        `SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`,
        [canonical.turnId, canonical.sessionId])).rows[0], value => value?.status === "completed" && typeof value.finalResponse === "string")
      expect(rootModelStreams).toBe(rootStreamsAtCandidate)

      const turn = await pool!.query<{ status: string; finalResponse: string | null; rootTaskId: string | null }>(
        `SELECT "status", "finalResponse", "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`,
        [canonical.turnId, canonical.sessionId])
      const rootTaskId = turn.rows[0]?.rootTaskId
      const finalItem = await pool!.query<{ content: unknown }>(
        `SELECT "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND "type" = 'agent_message' AND "phase" = 'final_answer' AND "status" = 'completed' ORDER BY "createdAt" DESC LIMIT 1`,
        [canonical.sessionId, canonical.turnId, rootTaskId])
      expect(turn.rows[0]?.status).toBe("completed")
      expect(persistedFinalCandidate(finalItem.rows[0]?.content, turn.rows[0]?.finalResponse)).toBe(acceptedCandidate)
      const completedEvents = await pool!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'turn.completed'`, [canonical.sessionId, canonical.turnId])
      expect(completedEvents.rows[0]?.count).toBe(1)

      const taskRows = await pool!.query<{ id: string; role: string; taskType: string; goal: string; status: string; attemptCount: number; result: Record<string, unknown> | null; expectedOutputSchema: unknown }>(
        `SELECT "id", "role", "taskType", "goal", "status", "attemptCount", "result", "expectedOutputSchema"
         FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "createdAt", "id"`, [canonical.sessionId, canonical.turnId])
      const target = taskRows.rows.find(row => row.role === "analyst" && row.goal === childGoal)
      expect(target).toMatchObject({ status: "completed", attemptCount: 1 })
      expect(JSON.stringify(target?.result)).toContain("Fact 42 is present")
      const reports = taskRows.rows.filter(row => row.role === "auditor" && row.taskType === "native_verification").map(row => {
        const control = parseNativeVerificationControl(row.expectedOutputSchema)
        const result = row.result && typeof row.result === "object" ? row.result.nativeVerificationReport as Record<string, unknown> | undefined : undefined
        return { id: row.id, status: row.status, control, report: result }
      })
      const passedChild = reports.find(row => row.control?.target.kind === "child" && row.control.target.taskId === target?.id)
      const failedRejectedRoot = reports.find(row => row.control?.target.kind === "root_goal" && row.control.target.candidateDigest === digestNativeVerificationValue(rejectedCandidate))
      const passedAcceptedRoot = reports.find(row => row.control?.target.kind === "root_goal" && row.control.target.candidateDigest === digestNativeVerificationValue(acceptedCandidate))
      if (!passedChild || !failedRejectedRoot || !passedAcceptedRoot) throw new Error("canonical child/rejected-root/accepted-root controls were not all persisted")
      expect(passedChild.report).toMatchObject({ disposition: "passed", controlTaskId: passedChild.id })
      expect(failedRejectedRoot.report).toMatchObject({ disposition: "failed", controlTaskId: failedRejectedRoot.id })
      expect(passedAcceptedRoot.report).toMatchObject({ disposition: "passed", controlTaskId: passedAcceptedRoot.id })
      expect(reports.every(row => row.status === "completed")).toBe(true)

      const usage = await pool!.query<{ inputTokens: string | number; outputTokens: string | number; estimatedCostUsd: string | number }>(
        `SELECT COALESCE(SUM("inputTokens"), 0) AS "inputTokens", COALESCE(SUM("outputTokens"), 0) AS "outputTokens",
          COALESCE(SUM("estimatedCostUsd"), 0) AS "estimatedCostUsd" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2`,
        [canonical.sessionId, canonical.turnId])
      expect(Number(usage.rows[0]?.inputTokens)).toBeGreaterThan(0)
      expect(Number(usage.rows[0]?.outputTokens)).toBeGreaterThan(0)
      expect(Number(usage.rows[0]?.estimatedCostUsd)).toBeGreaterThan(0)
      expect(usageAuthorizations.length).toBeGreaterThanOrEqual(6)
      expect(usageSettlements).toHaveLength(usageAuthorizations.length)
      const settledInputTokens = usageSettlements.reduce((sum, item) => sum + item.inputTokens, 0)
      const settledOutputTokens = usageSettlements.reduce((sum, item) => sum + item.outputTokens, 0)
      const settledCost = usageSettlements.reduce((sum, item) => sum + item.estimatedCostUsd, 0)
      expect(settledInputTokens).toBeGreaterThan(0)
      expect(settledOutputTokens).toBeGreaterThan(0)
      expect(Number(usage.rows[0]?.inputTokens)).toBe(settledInputTokens)
      expect(Number(usage.rows[0]?.outputTokens)).toBe(settledOutputTokens)
      expect(Number(usage.rows[0]?.estimatedCostUsd)).toBeCloseTo(settledCost, 6)
      const reservations = await pool!.query<{ status: string; taskId: string }>(
        `SELECT "status", "taskId" FROM "agent_tree_budget_reservations" WHERE "sessionId" = $1 AND "turnId" = $2`,
        [canonical.sessionId, canonical.turnId])
      expect(reservations.rows.length).toBeGreaterThanOrEqual(3)
      expect(reservations.rows.every(row => row.status === "consumed")).toBe(true)
      expect(reservations.rows.some(row => row.taskId === passedChild?.control?.controlTaskId)).toBe(true)
      expect(reservations.rows.some(row => row.taskId === passedAcceptedRoot?.id)).toBe(true)

      const [items, events, turnInput] = await Promise.all([
        pool!.query<{ content: unknown }>(`SELECT "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2`, [canonical.sessionId, canonical.turnId]),
        pool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2`, [canonical.sessionId, canonical.turnId]),
        pool!.query<{ input: unknown }>(`SELECT "input" FROM "agent_turns" WHERE "id" = $1`, [canonical.turnId]),
      ])
      const publicText = JSON.stringify({ items: items.rows, events: events.rows, input: turnInput.rows[0]?.input })
      expect(publicText).not.toContain(NATIVE_VERIFICATION_PACKET_CONTEXT_KEY)
      expect(publicText).not.toContain(NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA)
    } finally {
      await bootstrap?.close().catch(() => undefined)
      await closePool().catch(() => undefined)
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabaseUrl
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [canonical.sessionId]).catch(() => undefined)
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [canonical.userId]).catch(() => undefined)
    }
  }, 180_000)
})
