import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"

import { loadCanonicalTurnState } from "../canonical-turn-state.js"
import { executionOwnerFence, type ExecutionOwnerFence } from "../execution-owner.js"
import { PolicyEngine } from "../policy/engine.js"
import { createWorkerToolRuntime } from "../tools/index.js"
import { InMemoryToolLifecycleSink } from "../tools/lifecycle.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { TurnExecutionEventWriter, executeToolWithItems } from "../turns/turn-execution-events.js"
import type { TurnExecutionOptions, TurnExecutionStore } from "../turns/turn-execution-types.js"
import { claimTurnLease, type TurnLease } from "../turns/lease.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { reconcileDurableWaits } from "./durable-wait-resolver.js"
import { AgentTreeManager } from "./manager.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { createPgRootTaskStore } from "./root-task-store.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { readPrivateSponsorshipContext } from "./sponsorship-private-context-reader.js"
import { defaultSubagentPolicy, type SubagentLease, type SubagentTaskRecord } from "./types.js"
import type { TurnEngineToolExecutor } from "../turns/turn-engine-tool-executor.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const SOURCE_CANARY = "PRIVATE-SOURCING-CANARY: visa sponsorship may be considered for this role."
const MODEL = { provider: "fixture", model: "fixture-model" }

type Fixture = Readonly<{ userId: string; sessionId: string; turnId: string; ownerId: string; jobIds: readonly [string, string]; suffix: string }>
type WaitMode = "all" | "any"

function dedicatedDisposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Required private sponsorship context integration has no disposable PostgreSQL URL")
    return null
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error("Private sponsorship context integration requires the dedicated disposable CI PostgreSQL URL") }
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres"
    || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search !== "" || url.hash !== ""
    || process.env.DATABASE_URL !== value) {
    throw new Error("Private sponsorship context integration accepts only the required dedicated disposable PostgreSQL service")
  }
  return value
}

const databaseUrl = dedicatedDisposableUrl()
const describeWithDisposablePostgres = databaseUrl ? describe : describe.skip
const fixtures: Fixture[] = []

function fixture(): Fixture {
  const suffix = randomUUID()
  const value: Fixture = {
    userId: `p3-sponsorship-private-user-${suffix}`,
    sessionId: `p3-sponsorship-private-session-${suffix}`,
    turnId: `p3-sponsorship-private-turn-${suffix}`,
    ownerId: `p3-sponsorship-private-owner-${suffix}`,
    jobIds: [randomUUID(), randomUUID()], suffix,
  }
  fixtures.push(value)
  return value
}

async function seed(pool: Pool, value: Fixture): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Check saved job sponsorship evidence', 'running', 'test', CURRENT_TIMESTAMP)`, [value.sessionId, value.userId])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'queued', 'user', $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, CURRENT_TIMESTAMP)`, [
    value.turnId, value.sessionId, value.userId,
    JSON.stringify({ goal: "Check saved job sponsorship evidence" }), JSON.stringify(MODEL),
    JSON.stringify({ version: "policy.v1", rules: [] }), JSON.stringify({ limits: { maxSteps: 12, maxToolCalls: 24 } }),
  ])
  for (let index = 0; index < value.jobIds.length; index += 1) {
    await pool.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "workflowState", "updatedAt")
      VALUES ($1, $2, $3, 'Backend Engineer', 'Dublin', 'saved', $4, $5, 'greenhouse', 'draft', CURRENT_TIMESTAMP)`, [
      value.jobIds[index], value.userId, `Fixture Employer ${index + 1}`, `https://jobs.example.test/role-${index + 1}`, `${SOURCE_CANARY} listing-${index + 1}`,
    ])
  }
}

function subagentLease(task: SubagentTaskRecord, ownerId: string): SubagentLease {
  if (!task.leaseExpiresAt || !task.leaseOwner || task.attemptCount < 1) throw new Error("Fixture child did not receive a current lease")
  return { ...task, ownerId, leaseExpiresAt: task.leaseExpiresAt, signal: new AbortController().signal }
}

function makePolicy(): PolicyEngine {
  return new PolicyEngine({ snapshot: { version: "policy.v1", rules: [
    { id: "private-sponsorship-jobs-get", roles: ["subagent"], tools: ["jobs.get"], risks: ["read"], domains: ["jobs"],
      outcome: "allow", reasonCode: "fixture_read_allowed", reason: "Allow the fixture owner-scoped read" },
    { id: "private-sponsorship-root-wait", roles: ["orchestrator"], tools: ["agent.wait"], risks: ["internal_write"], domains: ["coordination"],
      requiredCapabilities: ["canManageChildren"], outcome: "allow", reasonCode: "fixture_wait_allowed", reason: "Allow the fixture durable wait" },
  ] } })
}

/**
 * Production TurnEngine.bindStore adapts the persisted owner-based store to
 * the shared execution loop's identity-based store. These focused fixture
 * calls use executeToolWithItems directly, so keep the same owner forwarding
 * for the exact store operations that writer needs.
 */
function bindToolExecutionStore(store: ReturnType<typeof createPgTurnEngineStore>): TurnExecutionOptions["store"] {
  return {
    createItem: ({ identity, ...input }) => store.createItem({ ...input, owner: identity }),
    updateItem: ({ identity, ...input }) => store.updateItem({ ...input, owner: identity }),
    appendEvent: ({ identity, ...input }) => store.appendEvent({ ...input, owner: identity }),
  } as TurnExecutionStore
}

function toolOptions(input: {
  identity: ExecutionOwnerFence
  store: ReturnType<typeof createPgTurnEngineStore>
  router: ReturnType<typeof createWorkerToolRuntime>["router"]
  actorRole: "orchestrator" | "subagent"
  capabilities: readonly string[]
}): TurnExecutionOptions {
  return {
    identity: input.identity,
    scope: { userId: input.identity.userId },
    goal: "Check saved job sponsorship evidence",
    snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    contextBuilder: { build: async () => ({}) as never },
    store: bindToolExecutionStore(input.store),
    model: {} as never,
    tools: [],
    actorRole: input.actorRole,
    capabilities: input.capabilities,
    signal: new AbortController().signal,
    executeTool: (async (request: Parameters<TurnEngineToolExecutor>[0]) => {
      const routed = await input.router.execute({
        scope: request.scope, sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId,
        taskId: request.taskId, rootTaskId: request.rootTaskId, actorRole: request.actorRole,
        capabilities: request.capabilities, signal: request.signal,
      }, { id: request.call.id, toolName: request.call.toolName, toolVersion: request.call.toolVersion, input: request.call.input })
      return { id: routed.id, toolName: routed.toolName, toolVersion: routed.toolVersion,
        status: routed.status, ...(routed.output === undefined ? {} : { output: routed.output }), errorCode: routed.errorCode }
    }) as TurnEngineToolExecutor,
  } as unknown as TurnExecutionOptions
}

async function invokeTool(input: {
  identity: ExecutionOwnerFence
  store: ReturnType<typeof createPgTurnEngineStore>
  router: ReturnType<typeof createWorkerToolRuntime>["router"]
  actorRole: "orchestrator" | "subagent"
  capabilities: readonly string[]
  stepId: string
  call: { id: string; name: string; arguments: unknown }
}): Promise<unknown> {
  const options = toolOptions(input)
  const step = { id: input.stepId, ordinal: 0 }
  const result = await executeToolWithItems(options, new TurnExecutionEventWriter(options), step,
    { id: input.call.id, name: input.call.name, arguments: input.call.arguments }, () => new Date())
  if (result.status !== "completed") throw new Error(`Fixture ${input.call.name} failed with ${result.errorCode ?? "no error code"}`)
  return result.output
}

async function finishScout(input: {
  tasks: PgSubagentTaskStore
  child: SubagentLease
  jobId: string
  candidateIndex: number
}): Promise<void> {
  const evidenceId = `fixture-job-evidence-${input.candidateIndex}`
  const result = {
    status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: [{ jobId: input.jobId, source: "greenhouse", url: `https://jobs.example.test/role-${input.candidateIndex + 1}`, evidenceIds: [evidenceId] }],
      evidence: [{ id: evidenceId, kind: "job", ref: input.jobId, source: "greenhouse" }],
      summary: "A saved job listing was read for this fixture.",
    },
  }
  const finished = await input.tasks.finish({ taskId: input.child.id, sessionId: input.child.sessionId,
    ownerId: input.child.ownerId, attemptCount: input.child.attemptCount, status: "completed", result, now: new Date() })
  if (finished !== "completed") throw new Error(`Fixture Scout ${input.candidateIndex + 1} did not finish`)
}

describeWithDisposablePostgres("private sponsorship context reader with disposable PostgreSQL", () => {
  let pool: Pool | undefined

  beforeAll(async () => {
    if (!databaseUrl) return
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    await pool.query("SELECT 1")
  })

  afterEach(async () => {
    if (!pool) return
    for (const value of fixtures.splice(0)) {
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  })

  afterAll(async () => { await pool?.end() })

  it.each(["all", "any"] as const)("rebinds a consumed async %s wait to current same-owner source and keeps excerpts out of public events", async mode => {
    const db = pool
    if (!db) throw new Error("Disposable PostgreSQL fixture was not initialized")
    const value = fixture()
    await seed(db, value)

    const turnLease = await claimTurnLease(db, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId }, new Date(), 300_000)
    const rootStore = createPgRootTaskStore(db)
    const root = await rootStore.ensure({ lease: turnLease, goal: "Check saved job sponsorship evidence",
      allowedActions: ["agent.wait", "jobs.get"], modelProfileSnapshot: MODEL,
      toolPolicySnapshot: { version: "policy.v1", rules: [] }, budgetSnapshot: { limits: { maxSteps: 12, maxToolCalls: 24 } } })
    const tasks = new PgSubagentTaskStore(db, 300_000)
    const policy = defaultSubagentPolicy()
    const childLeases: SubagentLease[] = []
    for (let index = 0; index < value.jobIds.length; index += 1) {
      const child = await tasks.create({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        parentTaskId: root.id, role: "scout", taskType: "job_discovery", goal: `Inspect fixture listing ${index + 1}`,
        allowedActions: ["jobs.get"], context: {}, expectedOutputSchema: {}, policy })
      const ownerId = `p3-sponsorship-private-child-owner-${value.suffix}-${index}`
      const claimed = await tasks.claim({ taskId: child.id, sessionId: value.sessionId, ownerId, policy, now: new Date() })
      if (!claimed) throw new Error(`Fixture Scout ${index + 1} did not acquire a lease`)
      const childLease = subagentLease(claimed, ownerId)
      childLeases.push(childLease)
    }

    const engine = createPgTurnEngineStore(db)
    const lifecycleSink = new InMemoryToolLifecycleSink()
    let currentRootLease: TurnLease = turnLease
    const childLeaseById = new Map(childLeases.map(lease => [lease.id, lease]))
    const runtime = createWorkerToolRuntime(db, {
      sink: lifecycleSink,
      resolveOwner: context => {
        if (context.taskId === root.id) return { kind: "turn", taskId: root.id, lease: currentRootLease }
        const lease = context.taskId ? childLeaseById.get(context.taskId) : undefined
        if (lease) return { kind: "task", lease }
        throw new Error("Fixture lifecycle owner was not found")
      },
    }, makePolicy(), { manager: new AgentTreeManager(tasks), wait: createPgDurableWaitPort(db) })

    // Each child performs a real owner-scoped jobs.get through ToolRouter. The
    // source proof is reconstructed later from these persisted call/result items.
    for (let index = 0; index < childLeases.length; index += 1) {
      const child = childLeases[index]!
      const identity = executionOwnerFence({ kind: "task", lease: child })
      const stepId = `p3-sponsorship-private-child-step-${value.suffix}-${index}`
      const step = await engine.startStep({ owner: identity, stepId, ordinal: 0, attempt: child.attemptCount,
        inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: MODEL, now: new Date() })
      const receipt = await invokeTool({ identity, store: engine, router: runtime.router, actorRole: "subagent", capabilities: [], stepId: step.id,
        call: { id: `p3-sponsorship-private-jobs-get-${value.suffix}-${index}`, name: "jobs.get", arguments: { jobId: value.jobIds[index] } } }) as { job?: { id?: string; description?: string | null } | null }
      expect(receipt.job?.id).toBe(value.jobIds[index])
      expect(receipt.job?.description).toContain(SOURCE_CANARY)
      await engine.updateStep({ owner: identity, stepId: step.id, status: "completed", finishReason: "stop", errorCode: null,
        inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: new Date() })
    }

    const rootIdentity = executionOwnerFence({ kind: "turn", taskId: root.id, lease: turnLease })
    const rootWaitStep = await engine.startStep({ owner: rootIdentity, stepId: `p3-sponsorship-private-root-wait-${value.suffix}`,
      ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: MODEL, now: new Date() })
    const durable = createPgDurableWaitPort(db)
    const waitIdKey = `p3-sponsorship-private-wait-${value.suffix}`
    let allPartialRaceApplied = false
    const waitPort = {
      wait: async (invocation: Parameters<typeof durable.wait>[0]) => {
        // executeWaitSubagents has already read both children at this point.
        // Completing A here makes the real DB wait store observe a partial
        // matched set while its persisted original tool snapshot still lags.
        if (mode === "all" && !allPartialRaceApplied) {
          allPartialRaceApplied = true
          await finishScout({ tasks, child: childLeases[0]!, jobId: value.jobIds[0], candidateIndex: 0 })
        }
        return durable.wait(invocation)
      },
      cancel: durable.cancel?.bind(durable),
    }
    const waitRuntime = createWorkerToolRuntime(db, {
      sink: lifecycleSink,
      resolveOwner: context => {
        if (context.taskId === root.id) return { kind: "turn", taskId: root.id, lease: currentRootLease }
        const lease = context.taskId ? childLeaseById.get(context.taskId) : undefined
        if (lease) return { kind: "task", lease }
        throw new Error("Fixture lifecycle owner was not found")
      },
    }, makePolicy(), { manager: new AgentTreeManager(tasks), wait: waitPort })
    const rootOptions = toolOptions({ identity: rootIdentity, store: engine, router: waitRuntime.router,
      actorRole: "orchestrator", capabilities: ["canManageChildren"] })
    const rootCallId = `p3-sponsorship-private-root-wait-call-${value.suffix}`
    const rawWaitOutput = await executeToolWithItems(rootOptions, new TurnExecutionEventWriter(rootOptions), rootWaitStep,
      { id: rootCallId, name: "agent.wait", arguments: { idempotencyKey: waitIdKey, taskIds: childLeases.map(child => child.id), mode, timeoutMs: 30_000 } },
      () => new Date())
    expect(rawWaitOutput.status).toBe("completed")
    expect(rawWaitOutput.output).toMatchObject({ status: "waiting", taskIds: childLeases.map(child => child.id) })
    const initial = rawWaitOutput.output as { waitId: string; matchedTaskIds: string[]; tasks: Array<{ status: string }> }
    expect(initial.waitId).toMatch(/^wait-/)
    expect(initial.matchedTaskIds).toEqual(mode === "all" ? [childLeases[0]!.id] : [])
    expect(initial.tasks.map(task => task.status)).toEqual(["running", "running"])

    await engine.updateStep({ owner: rootIdentity, stepId: rootWaitStep.id, status: "waiting_for_tool", finishReason: "tool_calls", errorCode: null,
      inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now: new Date() })
    const handoff = await durable.suspendAndRelease({ lease: turnLease, waitId: initial.waitId, now: new Date() })
    expect(handoff).toMatchObject({ handoff: "suspended", waitStatus: "waiting" })

    // A still-running child may need another model step after Root's wait step.
    // Step ordinals are Turn-global, so this child step sits between the wait
    // and the Root's resumed step and must not hide the nearest Root wait.
    const completingChildIndex = mode === "any" ? 0 : 1
    const completingChild = childLeases[completingChildIndex]!
    const completingChildIdentity = executionOwnerFence({ kind: "task", lease: completingChild })
    const interleavedChildStep = await engine.startStep({ owner: completingChildIdentity,
      stepId: `p3-sponsorship-private-child-interleave-${value.suffix}`, ordinal: 0,
      attempt: completingChild.attemptCount, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: MODEL, now: new Date() })
    expect(interleavedChildStep.ordinal).toBe(rootWaitStep.ordinal + 1)
    await engine.updateStep({ owner: completingChildIdentity, stepId: interleavedChildStep.id, status: "completed",
      finishReason: "stop", errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: new Date() })
    await finishScout({ tasks, child: completingChild, jobId: value.jobIds[completingChildIndex]!, candidateIndex: completingChildIndex })
    const resolver = await reconcileDurableWaits(db, { ownerId: `p3-sponsorship-private-resolver-${value.suffix}`, now: new Date() })
    expect(resolver.resolved).toBe(1)
    expect(resolver.woken).toBe(1)
    // any resolves on A; B can complete afterward without joining the matched set.
    if (mode === "any") await finishScout({ tasks, child: childLeases[1]!, jobId: value.jobIds[1], candidateIndex: 1 })

    currentRootLease = await claimTurnLease(db, { turnId: value.turnId, sessionId: value.sessionId,
      ownerId: `p3-sponsorship-private-resume-${value.suffix}` }, new Date(), 300_000)
    const resumedRoot = await rootStore.ensure({ lease: currentRootLease, goal: "Check saved job sponsorship evidence",
      allowedActions: ["agent.wait", "jobs.get"], modelProfileSnapshot: MODEL,
      toolPolicySnapshot: { version: "policy.v1", rules: [] }, budgetSnapshot: { limits: { maxSteps: 12, maxToolCalls: 24 } } })
    expect(resumedRoot.id).toBe(root.id)
    const restored = await loadCanonicalTurnState(db, currentRootLease, new Date(), { consumeWaitOutcomes: true })
    const durableProjection = restored.snapshot.toolObservations.filter(item => item.id === `wait-result:${initial.waitId}`)
    expect(durableProjection).toHaveLength(1)

    const resumedIdentity = executionOwnerFence({ kind: "turn", taskId: root.id, lease: currentRootLease })
    const currentStep = await engine.startStep({ owner: resumedIdentity, stepId: `p3-sponsorship-private-root-resume-${value.suffix}`,
      ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: MODEL, now: new Date() })
    expect(currentStep.ordinal).toBe(interleavedChildStep.ordinal + 1)
    const currentRoot = await pool!.query<{ parentTaskId: string | null; attemptCount: number }>(
      `SELECT "parentTaskId", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
      [root.id, value.sessionId, value.turnId])
    expect(currentRoot.rows).toEqual([{ parentTaskId: null, attemptCount: 1 }])

    const readerInput = { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, taskId: root.id, rootTaskId: root.id,
      rootAttemptCount: Number(currentRoot.rows[0]?.attemptCount), turnLeaseOwner: currentRootLease.ownerId,
      turnLeaseVersion: currentRootLease.leaseVersion, stepId: currentStep.id }
    const context = await readPrivateSponsorshipContext(db, readerInput, restored.snapshot.toolObservations)
    const expectedCount = mode === "all" ? 2 : 1
    expect(context).toHaveLength(expectedCount)
    expect(context?.map(entry => entry.jobId).sort()).toEqual(mode === "all" ? [...value.jobIds].sort() : [value.jobIds[0]])
    for (const entry of context ?? []) {
      expect(entry.observation).toMatchObject({ status: "inconclusive", reason: "interpretation_unverified",
        sourceContext: { trustBoundary: "untrusted_saved_job_listing", descriptionExcerpt: expect.stringContaining(SOURCE_CANARY) } })
    }

    const wrongOwner = await readPrivateSponsorshipContext(db, { ...readerInput, turnLeaseOwner: "foreign-private-reader-owner" }, restored.snapshot.toolObservations)
    expect(wrongOwner).toBeUndefined()

    if (mode === "all") {
      await db.query(`UPDATE "Job" SET "description" = 'Changed source after the durable jobs.get receipt', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "userId" = $2`, [value.jobIds[0], value.userId])
      const drifted = await readPrivateSponsorshipContext(db, readerInput, restored.snapshot.toolObservations)
      const driftedSourceMatches = drifted?.filter((entry) => entry.jobId === value.jobIds[0]) ?? []
      expect(driftedSourceMatches).toHaveLength(1)
      expect(driftedSourceMatches[0]?.observation).toMatchObject({ status: "unavailable", reason: "source_drift" })
      expect(driftedSourceMatches[0]?.observation).not.toHaveProperty("sourceContext")
    }

    const waitRows = await db.query<{ id: string; resultItemId: string | null }>(`SELECT call."id", result."id" AS "resultItemId"
      FROM "agent_items" AS call JOIN "agent_items" AS result ON result."taskId" = call."taskId" AND result."stepId" = call."stepId"
        AND result."turnId" = call."turnId" AND result."sessionId" = call."sessionId" AND result."type" = 'tool_result'
        AND result."content"->>'toolCallId' = call."content"->>'toolCallId'
      WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3 AND call."type" = 'tool_call'
        AND call."content"->>'toolCallId' = $4`,
    [value.sessionId, value.turnId, root.id, rootCallId])
    expect(waitRows.rows).toHaveLength(1)
    const publicRows = await db.query<{ content: unknown }>(`SELECT "content" FROM "agent_items"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = $4`,
    [value.sessionId, value.turnId, root.id, waitRows.rows[0]?.resultItemId])
    const publicTimeline = JSON.stringify(publicRows.rows)
    expect(publicTimeline).not.toContain(SOURCE_CANARY)
    expect(publicTimeline).not.toContain("sourceContext")
    expect(publicTimeline).not.toContain("untrusted_saved_job_listing")
    const waitEvents = await db.query<{ type: string; payload: unknown }>(`SELECT "type", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND ("taskId" = $3 OR "type" = 'turn.resumed')
        AND ("itemId" = $4 OR "type" = 'turn.resumed')`,
    [value.sessionId, value.turnId, root.id, waitRows.rows[0]?.id])
    const publicEvents = JSON.stringify(waitEvents.rows)
    expect(publicEvents).not.toContain(SOURCE_CANARY)
    expect(publicEvents).not.toContain("sourceContext")
    expect(publicEvents).not.toContain("untrusted_saved_job_listing")
    const publicWaitLifecycle = lifecycleSink.events.filter(event => event.item.type === "tool_result" && event.item.toolCallId === rootCallId)
    expect(JSON.stringify(publicWaitLifecycle)).not.toContain(SOURCE_CANARY)
    expect(JSON.stringify(publicWaitLifecycle)).not.toContain("sourceContext")
  })
})
