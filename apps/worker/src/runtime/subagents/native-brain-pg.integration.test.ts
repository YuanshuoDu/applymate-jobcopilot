import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Pool } from "pg"
import { Redis } from "ioredis"
import type { ModelAdapter } from "@jobcopilot/agent-model"
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
    ids.turn, ids.session, ids.user, JSON.stringify({ goal, successCriteria: turnCriteria }),
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
    for (const item of packet.evidence) {
      if (item.kind !== "tool_result") continue
      try {
        const row = JSON.parse(item.summary) as { tool?: unknown; status?: unknown; output?: { jobs?: Array<{ id?: unknown; description?: unknown }> } }
        const matchingJob = row.output?.jobs?.find(job => job.id === expectedFact.jobId
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
        const row = JSON.parse(item.summary) as { activeNative?: unknown; taskId?: unknown; criteria?: unknown; persistedResult?: { summary?: unknown } }
        return row.activeNative === true && typeof row.taskId === "string" ? [{ item, row }] : []
      } catch { return [] }
    })
    for (const { item, row } of activeNodes) {
      if (!Array.isArray(row.criteria) || !row.criteria.includes(turnCriteria[0])
        || typeof row.persistedResult?.summary !== "string"
        || !row.persistedResult.summary.toLowerCase().includes(expectedFact.phrase.toLowerCase())) continue
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
                : "The saved job does not contain the requested fact.",
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
      mailboxReader: (async (input: { taskId: string }) => { mailboxReads.push(input.taskId); return [] }) as never,
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
    expect(JSON.stringify(initialTask.rows[0]?.result)).toContain("does not contain")
    const targetToolRows = await pool!.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_result' AND "content"->>'toolName' = 'jobs.search'`,
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

    const publicRows = await pool!.query<{ content: unknown; payload: unknown }>(`SELECT item."content", event."payload"
      FROM "agent_items" AS item LEFT JOIN "agent_events" AS event ON event."sessionId" = item."sessionId" AND event."turnId" = item."turnId"
      WHERE item."sessionId" = $1 AND item."turnId" = $2 AND (item."type" = 'task_graph' OR event."type" IS NOT NULL)`, [ids.session, ids.turn])
    const serializedPublicRows = JSON.stringify(publicRows.rows)
    expect(serializedPublicRows).not.toContain(NATIVE_VERIFICATION_PACKET_CONTEXT_KEY)
    expect(serializedPublicRows).not.toContain(NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA)
    expect(serializedPublicRows).not.toContain("Fact 42 is absent")
    const requestEvents = await pool!.query<{ payload: Record<string, unknown> }>(`SELECT "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "type" = 'native_verification.requested'`, [ids.session])
    expect(requestEvents.rows.length).toBeGreaterThanOrEqual(4)
    expect(requestEvents.rows.every(row => !JSON.stringify(row.payload).includes(NATIVE_VERIFICATION_PACKET_CONTEXT_KEY)
      && !JSON.stringify(row.payload).includes(NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA))).toBe(true)
    expect(digestNativeVerificationValue(acceptedCandidate)).toMatch(/^[a-f0-9]{64}$/)
    await manager.shutdown()
  }, 120_000)
})
