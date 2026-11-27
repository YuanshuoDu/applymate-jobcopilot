import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION } from "@jobcopilot/shared"
import type { HarnessModelRequest, ModelAdapter, ModelCapabilityProfile } from "@jobcopilot/agent-model"

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
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import { bindSponsorshipFinalAnswer, TASK_GRAPH_FINAL_SUMMARY_BINDING, type TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { readSponsorshipFinalAnswerWithClient } from "./sponsorship-final-answer-reader.js"
import { buildGroundedTaskGraphFinalResponse } from "./task-graph-final-response.js"
import { formatTaskGraphFinalSummary } from "./task-graph-final-summary-format.js"
import { buildTaskGraphFinalSourceManifest } from "./task-graph-final-source-manifest.js"
import { createCanonicalTurnTerminalGuard } from "../canonical-turn-native-verification-runtime.js"
import { checkTaskGraphTerminalVerification, TASK_GRAPH_VERIFICATION_BLOCKER } from "../turns/turn-execution-completion-gate.js"
import { commitTurnTerminal } from "../turns/turn-engine-terminal-commit.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { readPrivateSponsorshipContext } from "./sponsorship-private-context-reader.js"
import { NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, parseNativeVerificationControl } from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import { defaultSubagentPolicy, type PgSubagentPool, type SubagentLease, type SubagentTaskRecord } from "./types.js"
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
    JSON.stringify({ goal: "Check saved job sponsorship evidence", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
      sponsorshipTargetCountry: { schemaVersion: OBJECTIVE_SPONSORSHIP_TARGET_COUNTRY_SCHEMA_VERSION, countryCode: "IE" } }), JSON.stringify(MODEL),
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
    { id: "private-sponsorship-root-review", roles: ["orchestrator"], tools: ["agent.review_sponsorship"], risks: ["internal_write"], domains: ["coordination"],
      requiredCapabilities: ["canManageChildren"], outcome: "allow", reasonCode: "fixture_review_allowed", reason: "Allow the fixture source-bound review request" },
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
  ordinal?: number
  call: { id: string; name: string; arguments: unknown }
}): Promise<unknown> {
  const options = toolOptions(input)
  const step = { id: input.stepId, ordinal: input.ordinal ?? 0 }
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
  const evidenceId = `read:job:${input.jobId}`
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

async function persistCompletedScoutVerificationReports(pool: Pool, input: Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string
}>): Promise<void> {
  const client = await pool.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [input.userId])
    const graphScope = { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId,
      rootTaskId: input.rootTaskId, parentTaskId: input.rootTaskId }
    const loaded = await loadTaskGraph(client, graphScope, true)
    if (!loaded.snapshot || !loaded.item) throw new Error("Fixture TaskGraph source was not persisted")
    for (const node of loaded.snapshot.nodes) {
      const task = loaded.tasks.get(node.taskId)
      const envelope = task?.result && typeof task.result === "object" && !Array.isArray(task.result)
        ? task.result as Record<string, unknown> : undefined
      if (!task || !envelope || !Object.hasOwn(envelope, "structuredResult") || task.status !== "completed"
        || !Number.isSafeInteger(task.attemptCount) || !task.attemptCount) throw new Error("Fixture Scout result was not completed")
      const verified = await verifyCompletedTaskGraphNodeEvidence(client, {
        scope: { ...graphScope, taskId: node.taskId, attemptCount: task.attemptCount },
        snapshot: loaded.snapshot, node, structuredResult: envelope.structuredResult,
      })
      if (!verified.verified || verified.report.status !== "passed") {
        throw new Error(`Fixture TaskGraph evidence did not verify: ${verified.report.reasonCode}`)
      }
      const stored = await client.query(`UPDATE "sub_agent_tasks" SET "result" = jsonb_set("result", '{taskGraphVerificationReport}', $1::jsonb, true), "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "rootTaskId" = $5 AND "parentTaskId" = $5
          AND "role" = 'scout' AND "taskType" = 'job_discovery' AND "status" = 'completed' AND "attemptCount" = $6
          AND "result"->>'status' = 'completed'`, [JSON.stringify(verified.report), node.taskId, input.sessionId,
        input.turnId, input.rootTaskId, task.attemptCount])
      if (stored.rowCount !== 1) throw new Error("Fixture verification report lost its completed Scout fence")
    }
    await client.query("COMMIT")
    open = false
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function commitGroundedFinalAnswer(input: Readonly<{
  pool: Pool
  engine: ReturnType<typeof createPgTurnEngineStore>
  identity: ExecutionOwnerFence
  lease: TurnLease
  scope: Parameters<typeof readSponsorshipFinalAnswerWithClient>[1]["scope"]
  rootAttemptCount: number
  stepId: string
  stepCount: number
  toolCallCount: number
  binding: TaskGraphFinalSummaryBinding
  nativeVerificationPassed: boolean
  expectSourceDriftBlocked?: boolean
}>): Promise<Readonly<{ committed: boolean; response: string; finalItemId: string; terminalAnswerRead: boolean; terminalAnswerAvailable: boolean }>> {
  if (input.identity.kind !== "turn" || input.identity.taskId !== input.identity.rootTaskId) {
    throw new Error("Fixture final answer requires the exact Root Turn identity")
  }
  const finalItemId = `p3-sponsorship-final-${randomUUID()}`
  const responseText = buildGroundedTaskGraphFinalResponse(input.binding)
  const summary = formatTaskGraphFinalSummary(input.binding.summary)
  const final = { schemaVersion: "agent-harness.v2.final", response: responseText, summary }
  const sources = buildTaskGraphFinalSourceManifest(input.binding, finalItemId)
  const finalContent = { text: responseText, final, ...(sources ? { taskGraphSources: sources } : {}) }
  const response = JSON.stringify(final)
  await input.engine.updateStep({ owner: input.identity, stepId: input.stepId, status: "completed", finishReason: "stop",
    errorCode: null, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001, now: new Date() })
  await input.engine.appendEvent({ owner: input.identity, id: randomUUID(), itemId: null, type: "step.completed",
    correlationId: input.stepId, causationId: null, idempotencyKey: `turn:${input.identity.turnId}:event:step-completed:${input.stepId}`,
    payload: { stepId: input.stepId, status: "completed", taskId: input.identity.taskId } })
  let terminalAnswerRead = false
  let terminalAnswerAvailable = false
  const guard = createCanonicalTurnTerminalGuard({
    enabled: true,
    // The PG witness exercises sponsorship/source and TaskGraph gates. Native
    // semantic completion is an independent prerequisite; this fixture marks
    // its result explicitly rather than pretending the sponsorship test proves it.
    nativeVerification: { checkTerminal: async () => ({ nativeVerificationPassed: input.nativeVerificationPassed }) } as never,
    checkRootGraph: async (client, nativeVerificationPassed, admission) =>
      checkTaskGraphTerminalVerification(client, input.lease, input.identity.rootTaskId, nativeVerificationPassed, true, admission),
    readSponsorshipFinalAnswer: async (client, stepId, graphBinding, targetCountryCode) => {
      terminalAnswerRead = true
      const answer = await readSponsorshipFinalAnswerWithClient(client, { scope: { ...input.scope, stepId }, rootAttemptCount: input.rootAttemptCount,
        targetCountryCode, graphBinding, expectedStepStatus: "completed" })
      terminalAnswerAvailable = answer !== undefined
      return answer
    },
  })
  if (!guard) throw new Error("Fixture sponsorship terminal guard was unavailable")
  const terminalInput = { owner: input.identity, stepId: input.stepId, finalItemId, finalContent,
    stepCount: input.stepCount, toolCallCount: input.toolCallCount,
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 }, response, now: new Date(),
    [TASK_GRAPH_FINAL_SUMMARY_BINDING]: input.binding }
  try {
    await commitTurnTerminal(input.pool, terminalInput as never, guard)
    return { committed: true, response: responseText, finalItemId, terminalAnswerRead, terminalAnswerAvailable }
  } catch (error) {
    if (!input.expectSourceDriftBlocked) throw error
    expect(error).toMatchObject({ name: "TaskGraphVerificationRecovery", blocker: TASK_GRAPH_VERIFICATION_BLOCKER })
    expect(terminalAnswerRead).toBe(true)
    expect(terminalAnswerAvailable).toBe(false)
    return { committed: false, response: responseText, finalItemId, terminalAnswerRead, terminalAnswerAvailable }
  }
}

async function executeSponsorshipAuditor(pool: Pool, input: Readonly<{ taskId: string; sessionId: string; rootTaskId: string }>): Promise<{
  outcome: { status: string }; requests: HarnessModelRequest[]
}> {
  const [{ createProductionChildExecutor }, { runSubagentQueueJob }] = await Promise.all([
    import("./production-child-runtime.js"), import("../../queue/subagent-pause-dispatch.js"),
  ])
  const requests: HarnessModelRequest[] = []
  const profile: ModelCapabilityProfile = {
    provider: "fixture", model: "sponsorship-review-deterministic", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
    supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
    maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
  }
  const executor = createProductionChildExecutor({
    pool,
    authorizeUsage: async () => ({ outputReservationRequired: false, maxOutputTokens: null,
      settle: async () => undefined, settleUnknown: async () => undefined }),
    modelRuntimeFactory: ({ task }) => {
      const control = parseNativeVerificationControl(task.expectedOutputSchema)
      const packet = control ? parseNativeVerificationPacket(task.context, control) : null
      if (!control || !packet || task.id !== input.taskId || packet.target.kind !== "sponsorship_source") {
        throw new Error("fixture_sponsorship_packet_unavailable")
      }
      const sourceEvidence = packet.evidence.find(item => {
        if (item.kind !== "saved_job_listing_description_segment") return false
        try {
          const summary = JSON.parse(item.summary) as { quote?: unknown }
          return typeof summary.quote === "string" && summary.quote.includes("Backend Engineer")
            && summary.quote.includes("Ireland") && summary.quote.includes("sponsorship is available")
        } catch { return false }
      })
      if (!sourceEvidence || packet.criteria.length !== 2) throw new Error("fixture_sponsorship_source_segment_unavailable")
      return {
        id: "sponsorship-review-deterministic", profile,
        async *stream(request: HarnessModelRequest) {
          requests.push(request)
          const report = { schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
            criteria: [
              { criterionId: packet.criteria[0]!.criterionId, disposition: "passed", reasonCode: "meets_criterion",
                evidenceReferenceIds: [sourceEvidence.referenceId] },
              { criterionId: packet.criteria[1]!.criterionId, disposition: "failed", reasonCode: "does_not_meet_criterion",
                evidenceReferenceIds: [] },
            ] }
          yield { type: "text_delta", text: JSON.stringify(report) }
          yield { type: "usage", inputTokens: 173, outputTokens: 41, estimatedCostUsd: 0.013 }
          yield { type: "completed", finishReason: "stop" }
        },
      } satisfies ModelAdapter
    },
  })
  const manager = new AgentTreeManager(new PgSubagentTaskStore(pool))
  try {
    const outcome = await runSubagentQueueJob(pool as unknown as PgSubagentPool, manager, executor, {
      taskId: input.taskId, sessionId: input.sessionId, rootTaskId: input.rootTaskId,
      ownerId: `p3-sponsorship-auditor-${randomUUID()}`,
    })
    return { outcome, requests }
  } finally { await manager.shutdown() }
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
    if (mode === "any") {
      await db.query(`UPDATE "Job" SET "description" = $3, "url" = $4, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "userId" = $2`, [value.jobIds[0], value.userId,
        "For this Backend Engineer role in Ireland, work visa sponsorship is available. PRIVATE-SPONSORSHIP-REVIEW-CANARY.",
        "https://jobs.example.test/role-1"])
    }

    const turnLease = await claimTurnLease(db, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId }, new Date(), 300_000)
    const rootStore = createPgRootTaskStore(db)
    const root = await rootStore.ensure({ lease: turnLease, goal: "Check saved job sponsorship evidence",
      allowedActions: ["agent.wait", "jobs.get", "agent.review_sponsorship"], modelProfileSnapshot: MODEL,
      toolPolicySnapshot: { version: "policy.v1", rules: [] }, budgetSnapshot: { limits: { maxSteps: 12, maxToolCalls: 24 } } })
    const tasks = new PgSubagentTaskStore(db, 300_000)
    const policy = defaultSubagentPolicy()
    const engine = createPgTurnEngineStore(db)
    const rootIdentity = executionOwnerFence({ kind: "turn", taskId: root.id, lease: turnLease })
    const rootWaitStep = await engine.startStep({ owner: rootIdentity, stepId: `p3-sponsorship-private-root-wait-${value.suffix}`,
      ordinal: 0, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: MODEL, now: new Date() })
    const graph = await createPgTaskGraphCommandPort(db).appendAndSchedule({
      scope: { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: root.id, parentTaskId: root.id,
        stepId: rootWaitStep.id, turnLeaseOwner: turnLease.ownerId, turnLeaseVersion: turnLease.leaseVersion,
        parentLeaseOwner: root.leaseOwner!, parentAttemptCount: root.attemptCount },
      proposal: { expectedRevision: 0, nodes: value.jobIds.map((_, index) => ({
        key: `scout-${index + 1}`, templateId: "scout", goal: `Inspect fixture listing ${index + 1}`,
        successCriteria: ["Return the current saved listing as a structured candidate."], dependsOn: [],
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
          criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }] },
      })) },
      templates: TASK_GRAPH_TEMPLATES,
    })
    expect(graph.nodes).toHaveLength(value.jobIds.length)
    const childLeases: SubagentLease[] = []
    for (let index = 0; index < value.jobIds.length; index += 1) {
      const graphNode = graph.nodes[index]
      if (!graphNode) throw new Error(`Fixture TaskGraph Scout ${index + 1} was not scheduled`)
      const ownerId = `p3-sponsorship-private-child-owner-${value.suffix}-${index}`
      const claimed = await tasks.claim({ taskId: graphNode.taskId, sessionId: value.sessionId, ownerId, policy, now: new Date() })
      if (!claimed) throw new Error(`Fixture Scout ${index + 1} did not acquire a lease`)
      const childLease = subagentLease(claimed, ownerId)
      childLeases.push(childLease)
    }

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
      const expectedDescriptionMarker = mode === "any" && index === 0 ? "PRIVATE-SPONSORSHIP-REVIEW-CANARY" : SOURCE_CANARY
      expect(receipt.job?.description?.includes(expectedDescriptionMarker)).toBe(true)
      await engine.updateStep({ owner: identity, stepId: step.id, status: "completed", finishReason: "stop", errorCode: null,
        inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: new Date() })
    }

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

    if (mode === "any") await finishScout({ tasks, child: childLeases[0]!, jobId: value.jobIds[0], candidateIndex: 0 })
    else await finishScout({ tasks, child: childLeases[1]!, jobId: value.jobIds[1], candidateIndex: 1 })
    const resolver = await reconcileDurableWaits(db, { ownerId: `p3-sponsorship-private-resolver-${value.suffix}`, now: new Date() })
    expect(resolver.resolved).toBe(1)
    expect(resolver.woken).toBe(1)
    // any resolves on A; B can complete afterward without joining the matched set.
    if (mode === "any") await finishScout({ tasks, child: childLeases[1]!, jobId: value.jobIds[1], candidateIndex: 1 })
    await persistCompletedScoutVerificationReports(db, { userId: value.userId, sessionId: value.sessionId,
      turnId: value.turnId, rootTaskId: root.id })

    currentRootLease = await claimTurnLease(db, { turnId: value.turnId, sessionId: value.sessionId,
      ownerId: `p3-sponsorship-private-resume-${value.suffix}` }, new Date(), 300_000)
    const resumedRoot = await rootStore.ensure({ lease: currentRootLease, goal: "Check saved job sponsorship evidence",
      allowedActions: ["agent.wait", "jobs.get", "agent.review_sponsorship"], modelProfileSnapshot: MODEL,
      toolPolicySnapshot: { version: "policy.v1", rules: [] }, budgetSnapshot: { limits: { maxSteps: 12, maxToolCalls: 24 } } })
    expect(resumedRoot.id).toBe(root.id)
    const restored = await loadCanonicalTurnState(db, currentRootLease, new Date(), { consumeWaitOutcomes: true })
    const durableProjection = restored.snapshot.toolObservations.filter(item => item.id === `wait-result:${initial.waitId}`)
    expect(durableProjection).toHaveLength(1)

    const resumedIdentity = executionOwnerFence({ kind: "turn", taskId: root.id, lease: currentRootLease })
    const currentStep = await engine.startStep({ owner: resumedIdentity, stepId: `p3-sponsorship-private-root-resume-${value.suffix}`,
      ordinal: 1, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: MODEL, now: new Date() })
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
    const expectedSourceCanary = mode === "any" ? "PRIVATE-SPONSORSHIP-REVIEW-CANARY" : SOURCE_CANARY
    for (const entry of context ?? []) {
      expect(entry.observation).toMatchObject({ status: "inconclusive", reason: "interpretation_unverified",
        sourceContext: { trustBoundary: "untrusted_saved_job_listing", descriptionExcerpt: expect.stringContaining(expectedSourceCanary) } })
    }

    const wrongOwner = await readPrivateSponsorshipContext(db, { ...readerInput, turnLeaseOwner: "foreign-private-reader-owner" }, restored.snapshot.toolObservations)
    expect(wrongOwner).toBeUndefined()

    if (mode === "any") {
      const currentRootAttempt = Number(currentRoot.rows[0]?.attemptCount)
      const reviewManager = new AgentTreeManager(tasks)
      const reviewRuntime = createWorkerToolRuntime(db, {
        sink: lifecycleSink,
        resolveOwner: context => {
          if (context.taskId === root.id) return { kind: "turn", taskId: root.id, lease: currentRootLease }
          const lease = context.taskId ? childLeaseById.get(context.taskId) : undefined
          if (lease) return { kind: "task", lease }
          throw new Error("Fixture lifecycle owner was not found")
        },
      }, makePolicy(), { manager: reviewManager, wait: durable, sponsorshipReviewEnabled: true,
        nativeCoordination: { enabled: true, turnLeaseOwner: currentRootLease.ownerId,
          turnLeaseVersion: currentRootLease.leaseVersion, parentLeaseOwner: currentRootLease.ownerId,
          parentAttemptCount: () => currentRootAttempt } })
      try {
        const reviewCallId = `p3-sponsorship-review-request-${value.suffix}`
        const review = await invokeTool({ identity: resumedIdentity, store: engine, router: reviewRuntime.router,
          actorRole: "orchestrator", capabilities: ["canManageChildren"], stepId: currentStep.id, ordinal: 1,
          call: { id: reviewCallId, name: "agent.review_sponsorship", arguments: { jobId: value.jobIds[0] } } }) as { taskId: string; status: string }
        expect(review.status).toBe("queued")
        await engine.updateStep({ owner: resumedIdentity, stepId: currentStep.id, status: "completed", finishReason: "tool_calls", errorCode: null,
          inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now: new Date() })

        const auditorWaitStep = await engine.startStep({ owner: resumedIdentity, stepId: `p3-sponsorship-review-wait-${value.suffix}`,
          ordinal: 2, attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: MODEL, now: new Date() })
        const auditorWaitCallId = `p3-sponsorship-review-wait-call-${value.suffix}`
        const auditorWait = await invokeTool({ identity: resumedIdentity, store: engine, router: reviewRuntime.router,
          actorRole: "orchestrator", capabilities: ["canManageChildren"], stepId: auditorWaitStep.id, ordinal: 2,
          call: { id: auditorWaitCallId, name: "agent.wait", arguments: { idempotencyKey: `p3-sponsorship-review-wait-key-${value.suffix}`,
            taskIds: [review.taskId], mode: "any", timeoutMs: 30_000 } } }) as { waitId: string; status: string }
        expect(auditorWait.status).toBe("waiting")
        await engine.updateStep({ owner: resumedIdentity, stepId: auditorWaitStep.id, status: "waiting_for_tool", finishReason: "tool_calls", errorCode: null,
          inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now: new Date() })
        const auditorHandoff = await durable.suspendAndRelease({ lease: currentRootLease, waitId: auditorWait.waitId, now: new Date() })
        expect(auditorHandoff).toMatchObject({ handoff: "suspended", waitStatus: "waiting" })

        const executed = await executeSponsorshipAuditor(db, { taskId: review.taskId, sessionId: value.sessionId, rootTaskId: root.id })
        expect(executed.outcome.status).toBe("completed")
        expect(executed.requests).toHaveLength(1)
        expect(executed.requests[0]?.tools).toEqual([])
        expect(JSON.stringify(executed.requests[0]?.messages)).toContain("PRIVATE-SPONSORSHIP-REVIEW-CANARY")

        const reviewerRows = await db.query<{ status: string; failureReason: string | null; result: unknown; qualityGateResult: unknown;
          context: unknown; expectedOutputSchema: unknown }>(
          `SELECT "status", "failureReason", "result", "qualityGateResult", "context", "expectedOutputSchema" FROM "sub_agent_tasks"
           WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
             AND "role" = 'auditor' AND "taskType" = 'native_verification'`, [review.taskId, value.sessionId, value.turnId, root.id])
        expect(reviewerRows.rows).toHaveLength(1)
        const reviewerRow = reviewerRows.rows[0]!
        expect(reviewerRow).toMatchObject({ status: "completed", failureReason: null,
          result: { status: "completed", toolCallCount: 0 } })
        const reviewerControl = parseNativeVerificationControl(reviewerRow.expectedOutputSchema)
        const reviewerPacket = reviewerControl ? parseNativeVerificationPacket(reviewerRow.context, reviewerControl) : null
        const citedSource = reviewerPacket?.evidence.find(item => {
          if (item.kind !== "saved_job_listing_description_segment") return false
          try {
            const summary = JSON.parse(item.summary) as { quote?: unknown }
            return typeof summary.quote === "string" && summary.quote.includes("Backend Engineer")
              && summary.quote.includes("Ireland") && summary.quote.includes("sponsorship is available")
          } catch { return false }
        })
        expect(citedSource?.referenceId).toMatch(/^sponsorship-citation:[a-f0-9]{32}$/)
        const qualityGate = reviewerRow.qualityGateResult as { disposition?: unknown; criteria?: unknown }
        expect(qualityGate.disposition).toBe("failed")
        expect(qualityGate.criteria).toEqual([
          { criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion",
            evidenceReferenceIds: [citedSource!.referenceId] },
          { criterionId: "criterion-2", disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] },
        ])
        const reviewPublicRows = await db.query<{ type: string; payload: unknown }>(`SELECT "type", "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" IN ($3, $4)`
        , [value.sessionId, value.turnId, root.id, review.taskId])
        const reviewPublicOutbox = await db.query<{ payload: unknown }>(`SELECT outbox."payload" FROM "agent_outbox" AS outbox
          JOIN "agent_events" AS event ON event."id" = outbox."payload"->>'eventId'
          WHERE outbox."aggregateId" = $1 AND event."turnId" = $2 AND event."taskId" IN ($3, $4)`
        , [value.sessionId, value.turnId, root.id, review.taskId])
        expect(JSON.stringify({ events: reviewPublicRows.rows, outbox: reviewPublicOutbox.rows, result: reviewerRow.result }))
          .not.toContain("PRIVATE-SPONSORSHIP-REVIEW-CANARY")

        const auditorResolver = await reconcileDurableWaits(db, { ownerId: `p3-sponsorship-review-resolver-${value.suffix}`, now: new Date() })
        expect(auditorResolver.resolved).toBe(1)
        expect(auditorResolver.woken).toBe(1)
        currentRootLease = await claimTurnLease(db, { turnId: value.turnId, sessionId: value.sessionId,
          ownerId: `p3-sponsorship-review-resume-${value.suffix}` }, new Date(), 300_000)
        const reviewerResumedRoot = await rootStore.ensure({ lease: currentRootLease, goal: "Check saved job sponsorship evidence",
          allowedActions: ["agent.wait", "jobs.get", "agent.review_sponsorship"], modelProfileSnapshot: MODEL,
          toolPolicySnapshot: { version: "policy.v1", rules: [] }, budgetSnapshot: { limits: { maxSteps: 12, maxToolCalls: 24 } } })
        expect(reviewerResumedRoot.id).toBe(root.id)
        const reviewerRestored = await loadCanonicalTurnState(db, currentRootLease, new Date(), { consumeWaitOutcomes: true })
        const privateReviewStep = await engine.startStep({ owner: executionOwnerFence({ kind: "turn", taskId: root.id, lease: currentRootLease }),
          stepId: `p3-sponsorship-review-private-context-${value.suffix}`, ordinal: 3, attempt: 1,
          inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: MODEL, now: new Date() })
        const reviewContext = await readPrivateSponsorshipContext(db, { userId: value.userId, sessionId: value.sessionId,
          turnId: value.turnId, taskId: root.id, rootTaskId: root.id, rootAttemptCount: currentRootAttempt,
          turnLeaseOwner: currentRootLease.ownerId, turnLeaseVersion: currentRootLease.leaseVersion, stepId: privateReviewStep.id },
        reviewerRestored.snapshot.toolObservations)
        expect(reviewContext).toHaveLength(1)
        expect(reviewContext?.[0]).toMatchObject({ jobId: value.jobIds[0], observation: {
          status: "explicit", claim: { kind: "work_visa_sponsorship", polarity: "available", countryCode: "IE" },
          citation: { sourceRef: "saved_job_listing.description", quote: expect.stringContaining("Backend Engineer") },
          sourceContext: { sourceUrl: "https://jobs.example.test/role-1", trustBoundary: "untrusted_saved_job_listing",
            descriptionExcerpt: expect.stringContaining("PRIVATE-SPONSORSHIP-REVIEW-CANARY") },
        } })

        const finalScope = { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
          rootTaskId: root.id, parentTaskId: root.id, stepId: privateReviewStep.id,
          turnLeaseOwner: currentRootLease.ownerId, turnLeaseVersion: currentRootLease.leaseVersion,
          parentLeaseOwner: currentRootLease.ownerId, parentAttemptCount: currentRootAttempt }
        const finalClient = await db.connect()
        const tracedSql: string[] = []
        let graphBinding: TaskGraphFinalSummaryBinding | undefined
        let candidateBinding: Awaited<ReturnType<typeof readSponsorshipFinalAnswerWithClient>> | undefined
        try {
          await finalClient.query("BEGIN")
          await finalClient.query("SELECT set_config('app.user_id', $1, true)", [value.userId])
          const graphGate = await checkTaskGraphTerminalVerification(finalClient, currentRootLease, root.id, true, true)
          if (!graphGate.ok) throw new Error("Fixture final answer TaskGraph verification failed")
          graphBinding = graphGate[TASK_GRAPH_FINAL_SUMMARY_BINDING]
          if (!graphBinding) throw new Error("Fixture final answer requires the production TaskGraph completion binding")
          const traced = { query: (sql: string, values?: readonly unknown[]) => {
            tracedSql.push(sql)
            return finalClient.query(sql, values as never)
          } }
          candidateBinding = await readSponsorshipFinalAnswerWithClient(traced as never, { scope: finalScope,
            rootAttemptCount: currentRootAttempt, targetCountryCode: "IE", graphBinding, expectedStepStatus: "streaming" })
          expect(candidateBinding?.outcomes).toHaveLength(1)
          const rootLockIndex = tracedSql.findIndex(sql => sql.includes('task."leaseOwner" = $6') && sql.includes("FOR UPDATE OF task"))
          const reviewerLockIndex = tracedSql.findIndex(sql => sql.includes('task."role" = \'auditor\'') && sql.includes("FOR UPDATE OF task"))
          const sourceTaskLockIndex = tracedSql.findIndex(sql => sql.includes('task."role" = \'scout\'') && sql.includes("FOR SHARE OF task"))
          const jobLockIndex = tracedSql.findIndex(sql => sql.includes('FROM "Job"') && sql.includes("FOR SHARE"))
          expect(rootLockIndex).toBeGreaterThanOrEqual(0)
          expect(reviewerLockIndex).toBeGreaterThan(rootLockIndex)
          expect(sourceTaskLockIndex).toBeGreaterThan(reviewerLockIndex)
          expect(jobLockIndex).toBeGreaterThan(sourceTaskLockIndex)

          const wrongOwner = await readSponsorshipFinalAnswerWithClient(traced as never, { scope: {
            ...finalScope, turnLeaseOwner: "foreign-sponsorship-owner", parentLeaseOwner: "foreign-sponsorship-owner",
          }, rootAttemptCount: currentRootAttempt, targetCountryCode: "IE", graphBinding, expectedStepStatus: "streaming" })
          expect(wrongOwner).toBeUndefined()
          const wrongAttempt = await readSponsorshipFinalAnswerWithClient(traced as never, { scope: finalScope,
            rootAttemptCount: currentRootAttempt + 1, targetCountryCode: "IE", graphBinding, expectedStepStatus: "streaming" })
          expect(wrongAttempt).toBeUndefined()

          const competing = await db.connect()
          let lockError: unknown
          try {
            await competing.query("BEGIN")
            await competing.query("SET LOCAL lock_timeout = '150ms'")
            await competing.query(`UPDATE "Job" SET "description" = "description" WHERE "id" = $1 AND "userId" = $2`,
              [value.jobIds[0], value.userId])
          } catch (error) { lockError = error }
          finally {
            await competing.query("ROLLBACK").catch(() => undefined)
            competing.release()
          }
          expect((lockError as { code?: unknown } | undefined)?.code).toBe("55P03")
          await finalClient.query("COMMIT")
        } catch (error) {
          await finalClient.query("ROLLBACK").catch(() => undefined)
          throw error
        } finally { finalClient.release() }
        if (!graphBinding) throw new Error("Fixture final answer TaskGraph binding was not retained")
        const reviewedFinalBinding = bindSponsorshipFinalAnswer(graphBinding, candidateBinding)
        expect(reviewedFinalBinding).not.toBeNull()
        if (!reviewedFinalBinding) throw new Error("Fixture could not bind the current reviewed source to its graph")

        const oldCitation = reviewContext?.[0]?.observation.status === "explicit" ? reviewContext[0].observation.citation.quote : ""
        expect(oldCitation).toContain("PRIVATE-SPONSORSHIP-REVIEW-CANARY")
        await db.query(`UPDATE "Job" SET "description" = 'Listing changed after the sponsorship review completed.', "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1 AND "userId" = $2`, [value.jobIds[0], value.userId])
        const afterReviewDrift = await readPrivateSponsorshipContext(db, { userId: value.userId, sessionId: value.sessionId,
          turnId: value.turnId, taskId: root.id, rootTaskId: root.id, rootAttemptCount: currentRootAttempt,
          turnLeaseOwner: currentRootLease.ownerId, turnLeaseVersion: currentRootLease.leaseVersion, stepId: privateReviewStep.id },
        reviewerRestored.snapshot.toolObservations)
        expect(afterReviewDrift).toBeUndefined()
        const postDriftCitations = (afterReviewDrift ?? []).flatMap(entry => entry.observation.status === "explicit"
          ? [entry.observation.citation.quote] : [])
        expect(postDriftCitations).toEqual([])
        expect(JSON.stringify(afterReviewDrift ?? [])).not.toContain(oldCitation)

        const staleTerminal = await commitGroundedFinalAnswer({ pool: db, engine, identity: resumedIdentity,
          lease: currentRootLease, scope: finalScope, rootAttemptCount: currentRootAttempt,
          stepId: privateReviewStep.id, stepCount: 4, toolCallCount: 4,
          binding: reviewedFinalBinding, nativeVerificationPassed: true, expectSourceDriftBlocked: true })
        expect(staleTerminal.committed).toBe(false)
        expect(staleTerminal.terminalAnswerRead).toBe(true)
        expect(staleTerminal.terminalAnswerAvailable).toBe(false)
        expect(staleTerminal.response).toContain("listing explicitly states that work visa sponsorship is available")
        const afterRejectedCommit = await db.query<{ status: string; finalResponse: string | null }>(
          `SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
          [value.turnId, value.sessionId, value.userId])
        expect(afterRejectedCommit.rows).toEqual([{ status: "in_progress", finalResponse: null }])
        const rejectedFinalItem = await db.query(`SELECT 1 FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2`,
          [staleTerminal.finalItemId, value.sessionId])
        expect(rejectedFinalItem.rows).toHaveLength(0)
      } finally { await reviewManager.shutdown() }
    }

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

    if (mode === "all") {
      const rootAttemptCount = Number(currentRoot.rows[0]?.attemptCount)
      const finalScope = { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        rootTaskId: root.id, parentTaskId: root.id, stepId: currentStep.id,
        turnLeaseOwner: currentRootLease.ownerId, turnLeaseVersion: currentRootLease.leaseVersion,
        parentLeaseOwner: currentRootLease.ownerId, parentAttemptCount: rootAttemptCount }
      const finalClient = await db.connect()
      let graphBinding: TaskGraphFinalSummaryBinding | undefined
      let currentAnswer: Awaited<ReturnType<typeof readSponsorshipFinalAnswerWithClient>> | undefined
      try {
        await finalClient.query("BEGIN")
        await finalClient.query("SELECT set_config('app.user_id', $1, true)", [value.userId])
        const graphGate = await checkTaskGraphTerminalVerification(finalClient, currentRootLease, root.id, false, true)
        if (!graphGate.ok) throw new Error("Fixture no-review TaskGraph verification failed")
        graphBinding = graphGate[TASK_GRAPH_FINAL_SUMMARY_BINDING]
        if (!graphBinding) throw new Error("Fixture no-review answer requires the production TaskGraph completion binding")
        currentAnswer = await readSponsorshipFinalAnswerWithClient(finalClient, { scope: finalScope,
          rootAttemptCount, targetCountryCode: "IE", graphBinding, expectedStepStatus: "streaming" })
        await finalClient.query("COMMIT")
      } catch (error) {
        await finalClient.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { finalClient.release() }
      if (!graphBinding) throw new Error("Fixture no-review TaskGraph binding was not retained")
      expect(currentAnswer?.outcomes).toEqual([])
      const noReviewBinding = bindSponsorshipFinalAnswer(graphBinding, currentAnswer)
      expect(noReviewBinding).not.toBeNull()
      if (!noReviewBinding) throw new Error("Fixture did not bind the no-review outcome")
      const noReviewText = buildGroundedTaskGraphFinalResponse(noReviewBinding)
      expect(noReviewText).toMatch(/Search results: 2 unique jobs/)
      expect(noReviewText).toContain("Sponsorship assessment for Ireland: no current completed listing review was available, so availability is unknown.")
      expect(noReviewText).toContain("An absent review is not evidence that sponsorship is unavailable.")
      expect(noReviewText).not.toContain(SOURCE_CANARY)

      const completed = await commitGroundedFinalAnswer({ pool: db, engine, identity: resumedIdentity,
        lease: currentRootLease, scope: finalScope, rootAttemptCount, stepId: currentStep.id,
        stepCount: 2, toolCallCount: 2, binding: noReviewBinding, nativeVerificationPassed: false })
      expect(completed.committed).toBe(true)
      expect(completed.terminalAnswerRead).toBe(true)
      expect(completed.terminalAnswerAvailable).toBe(true)
      expect(completed.response).toBe(noReviewText)
      const terminalTurn = await db.query<{ status: string; finalResponse: string | null }>(
        `SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
        [value.turnId, value.sessionId, value.userId])
      expect(terminalTurn.rows[0]?.status).toBe("completed")
      expect(terminalTurn.rows[0]?.finalResponse).toContain("availability is unknown")
    }
  })
})
