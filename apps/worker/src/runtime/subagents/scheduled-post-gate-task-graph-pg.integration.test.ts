import { randomUUID } from "node:crypto"
import { Pool, type PoolClient } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { claimTurnLease, releaseTurnLease, type TurnLease } from "../turns/lease.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { buildCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE } from "../turns/cognitive-agenda-receipt.js"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import type { StepContext } from "../context/step-context-builder.js"
import { createCanonicalExecutionProjection } from "../canonical-execution-projection.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { createPgRootTaskStore } from "./root-task-store.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { createScheduledAutomationGateContinuation } from "./scheduled-automation-gate-bridge.js"
import { createScheduledGatePrepareFixture } from "./scheduled-gate-prepare-pg-runner.fixture.js"
import { createScheduledGateChildExecutor } from "./scheduled-gate-child-runtime.js"
import { createScheduledPostGateChildExecutor } from "./scheduled-post-gate-child-runtime.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { policyFromTask } from "./manager-task-scope.js"
import { SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"
import { SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL,
  SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, SCHEDULED_POST_GATE_EXECUTE_CRITERIA,
  SCHEDULED_POST_GATE_EXECUTE_GOAL, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID } from "./scheduled-post-gate-contract.js"
import { readScheduledPostGateReceipt, validateScheduledPostGateHandoff } from "./scheduled-post-gate-handoff.js"
import { loadTaskGraph, lockTaskGraphScope } from "./task-graph-pg-state.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import { projectScheduledPipelineGraphAtCurrentStage } from "./scheduled-pipeline-graph-shape.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphFingerprint, taskGraphItemId,
  taskGraphProposalKey } from "./task-graph-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { executionKey } from "../turns/turn-execution-types.js"
import type { TaskGraphProposal } from "../planning/task-graph.js"
import type { SubagentExecutionResult, SubagentLease } from "./types.js"

const databaseUrl = disposableDatabaseUrl(), redisUrl = disposableRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip
const rootActions = [...new Set([...TASK_GRAPH_TEMPLATES.scout.allowedActions, ...TASK_GRAPH_TEMPLATES.analyst.allowedActions,
  ...TASK_GRAPH_TEMPLATES.prepare.allowedActions])]
const zeroReport = { processed: 0, applied: 0, queued: 0, pending: 0, skipped: 0, failed: 0, durationMs: 0 }
let pool: Pool | undefined
let priorDatabaseUrl: string | undefined
let priorWebUrl: string | undefined
let priorWorkerSecret: string | undefined
const fixtureUsers: string[] = []

describeWithServices("scheduled post-Gate TaskGraph handoff in disposable PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 8 })
    priorDatabaseUrl = process.env.DATABASE_URL
    priorWebUrl = process.env.AGENT_WEB_URL
    priorWorkerSecret = process.env.AGENT_WORKER_SECRET
    const prismaUrl = new URL(databaseUrl!)
    prismaUrl.searchParams.set("application_name", `scheduled-post-gate-pg-${randomUUID()}`)
    process.env.DATABASE_URL = prismaUrl.toString()
    process.env.AGENT_WEB_URL = "http://scheduled-post-gate-parent.invalid"
    process.env.AGENT_WORKER_SECRET = "scheduled-post-gate-fixture-secret"
  })

  afterEach(async () => {
    if (!pool || fixtureUsers.length === 0) return
    const users = [...fixtureUsers]
    const sessions = await pool.query<{ id: string }>(`SELECT "id" FROM "agent_sessions" WHERE "userId" = ANY($1::text[])`, [users])
    if (sessions.rows.length) await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`,
      [sessions.rows.map(row => row.id)])
    await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [users])
    fixtureUsers.splice(0, users.length)
  })

  afterAll(async () => {
    if (pool && fixtureUsers.length) await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [fixtureUsers])
    await pool?.end()
    restoreEnv("DATABASE_URL", priorDatabaseUrl)
    restoreEnv("AGENT_WEB_URL", priorWebUrl)
    restoreEnv("AGENT_WORKER_SECRET", priorWorkerSecret)
  })

  it("persists one immutable plan, rehydrates after a new Root lease, and verifies Execute plus Audit", async () => {
    const db = pool ??= new Pool({ connectionString: databaseUrl!, max: 8 })
    const fixture = await createScheduledGatePrepareFixture(db, redisUrl!, { jobCount: 2, scoutCount: 2 })
    fixtureUsers.push(fixture.ids.userId)
    const released = await releaseTurnLease(db, fixture.turnLease, "queued")
    expect(released).toBe(true)
    const lease = await claimTurnLease(db, { turnId: fixture.ids.turnId, sessionId: fixture.ids.sessionId,
      ownerId: `scheduled-post-gate-root-${randomUUID()}` })
    expect(lease.leaseVersion).toBeGreaterThan(fixture.owner.turnLeaseVersion)

    const rootStore = createPgRootTaskStore(db as never), execution = createCanonicalExecutionProjection(db)
    const turnStore = createPgTurnEngineStore(db as never), waitPort = createPgDurableWaitPort(db)
    const command = createPgTaskGraphCommandPort(db as never), store = new PgSubagentTaskStore(db as never)
    const owner = { ...fixture.owner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
    const executionOwner = turnFence(lease, fixture.ids.rootTaskId)
    await adoptRootLease(fixture, lease, rootStore, execution)
    const attestation = await fixture.reattestCurrentTurn(lease)
    const initialStep = await startStep(fixture, lease, turnStore)
    const continuation = createScheduledAutomationGateContinuation({ pool: db, commandPort: command, waitPort,
      nativeQuestionWaitEnabled: true, fetcher: async (_url, init = {}) => {
        const body = record(JSON.parse(String(init.body)))
        expect(body.action).toBe("gate")
        return jsonResponse({ status: "completed", nextStage: "execute", approvedJobIds: [], pendingJobIds: [],
          skippedJobIds: [...fixture.preparedJobIds].sort(), counts: { approved: 0, pending: 0, skipped: fixture.preparedJobIds.length } })
      } })
    const first = await continuation({ owner, executionOwner, attestation, handoff: fixture.handoff as never,
      prepareProof: fixture.prepareProof as never, finalStepId: initialStep, recoveryStepId: initialStep,
      signal: new AbortController().signal })
    expect(first.status).toBe("waiting_for_dependency")

    const gateTaskId = await findTaskId(db, fixture.ids.rootTaskId, "scheduled_taskgraph_gate")
    const gateTask = await store.get(gateTaskId, fixture.ids.sessionId)
    if (!gateTask) throw new Error("scheduled_post_gate_gate_task_missing")
    const gateOwnerId = `scheduled-post-gate-gate-${randomUUID()}`
    const gateClaim = await store.claim({ taskId: gateTaskId, sessionId: fixture.ids.sessionId, ownerId: gateOwnerId,
      policy: policyFromTask(gateTask), now: new Date() })
    if (!gateClaim) throw new Error("scheduled_post_gate_gate_claim_missing")
    const gateExecutor = createScheduledGateChildExecutor({ pool: db, fetcher: async () => jsonResponse({ status: "completed",
      nextStage: "execute", approvedJobIds: [], pendingJobIds: [], skippedJobIds: [...fixture.preparedJobIds].sort(),
      counts: { approved: 0, pending: 0, skipped: fixture.preparedJobIds.length } }) })
    const gateResult = await gateExecutor({ lease: leaseFor(gateClaim, gateOwnerId), continuation: undefined })
    await finishTask(store, gateClaim, gateOwnerId, gateResult)
    expect((await store.get(gateTaskId, fixture.ids.sessionId))?.status).toBe("completed")

    const requested = await continuation({ owner, executionOwner, mode: "resume_post_gate", finalStepId: initialStep,
      recoveryStepId: initialStep, signal: new AbortController().signal })
    expect(requested.status).toBe("replan")
    const readScope = { ...fixture.graphScope, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
      parentLeaseOwner: lease.ownerId, parentAttemptCount: fixture.owner.rootAttemptCount }
    const context = await command.readScheduledPostGatePlanningContext?.({ scope: readScope })
    expect(context?.status).toBe("awaiting_plan")
    if (!context || context.status !== "awaiting_plan") throw new Error("scheduled_post_gate_plan_context_missing")
    const preAppendRows = await db.query<{ content: unknown }>(
      "SELECT \"content\" FROM \"agent_items\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3 AND \"taskId\" = $4 AND \"type\" = 'task_graph'",
      [taskGraphItemId(fixture.ids.rootTaskId), fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId])
    if (preAppendRows.rows.length !== 1) throw new Error("scheduled_post_gate_pre_append_snapshot_missing")
    const preAppendSnapshot = parseTaskGraphSnapshot(preAppendRows.rows[0]!.content)
    expect(projectScheduledPipelineGraphAtCurrentStage(preAppendSnapshot.nodes)).toMatchObject({
      version: "v2", projection: { stage: "gate" },
    })
    const planStep = await startStep(fixture, lease, turnStore)
    const scope = { ...readScope, stepId: planStep }
    const proposal: TaskGraphProposal = { expectedRevision: context.graphRevision, nodes: [
      { key: "execute-1", templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, goal: SCHEDULED_POST_GATE_EXECUTE_GOAL,
        successCriteria: SCHEDULED_POST_GATE_EXECUTE_CRITERIA, dependsOn: ["gate"], packageRefs: [] },
      { key: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
        goal: SCHEDULED_POST_GATE_AUDIT_GOAL, successCriteria: SCHEDULED_POST_GATE_AUDIT_CRITERIA, dependsOn: ["execute-1"] },
    ] }
    const callId = randomUUID(), operation = { scope, decision: "revise" as const, expectedRevision: context.graphRevision, callId }
    await seedAgentPlanHistory(db, lease, fixture.ids.rootTaskId, planStep, context.graphRevision, proposal, callId)
    const input = { scope, proposal, operation }
    const admitted = await command.appendScheduledPostGatePlan?.(input)
    expect(admitted?.status).toBe("accepted")
    let replay: Awaited<ReturnType<NonNullable<typeof command.appendScheduledPostGatePlan>>> | undefined
    try {
      replay = await command.appendScheduledPostGatePlan?.(input)
    } catch (error: unknown) {
      if (errorCode(error) === "scheduled_post_gate_receipt_invalid") {
        const replayDiagnostic = await diagnoseScheduledPostGateReplay(db, scope)
        throw new Error(`scheduled_post_gate_receipt_invalid_diagnostic:${JSON.stringify(replayDiagnostic)}`)
      }
      throw error
    }
    expect(replay).toMatchObject({ status: "duplicate", revision: admitted?.revision, nodes: admitted?.nodes })
    if (!admitted || admitted.nodes.length !== 2) throw new Error("scheduled_post_gate_plan_not_admitted")

    expect(await releaseTurnLease(db, lease, "queued")).toBe(true)
    const resumedLease = await claimTurnLease(db, { turnId: fixture.ids.turnId, sessionId: fixture.ids.sessionId,
      ownerId: `scheduled-post-gate-root-restarted-${randomUUID()}` })
    await adoptRootLease(fixture, resumedLease, rootStore, execution)
    const resumedOwner = { ...owner, turnLeaseOwnerId: resumedLease.ownerId, turnLeaseVersion: resumedLease.leaseVersion }
    const resumedExecutionOwner = turnFence(resumedLease, fixture.ids.rootTaskId)
    const recoveryStep = await startStep(fixture, resumedLease, turnStore)

    const rpcBodies: Record<string, unknown>[] = []
    const postGateFetcher: typeof fetch = async (url, init = {}) => {
      expect(String(url)).toBe("http://scheduled-post-gate-parent.invalid/api/internal/agent-runtime/scheduled-pipeline")
      expect(new Headers(init.headers).get("x-agent-worker-secret")).toBe("scheduled-post-gate-fixture-secret")
      const body = record(JSON.parse(String(init.body)))
      rpcBodies.push(body)
      if (body.action === "scheduled_post_gate_execute") {
        expect(Object.keys(body).sort()).toEqual(["action", "actor", "attestation", "handoff", "owner", "packageRefs"].sort())
        expect(body.packageRefs).toEqual([])
        return jsonResponse({ status: "completed", structuredResult: { queued: [], failed: [] } })
      }
      expect(body.action).toBe("scheduled_post_gate_audit")
      expect(Object.keys(body).sort()).toEqual(["action", "actor", "attestation", "handoff", "owner"].sort())
      return jsonResponse({ status: "completed", report: zeroReport })
    }
    const postGateExecutor = createScheduledPostGateChildExecutor({ pool: db, fetcher: postGateFetcher })
    const executeTask = admitted.nodes.find(node => node.key === "execute-1")!, auditTask = admitted.nodes.find(node => node.key === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID)!
    await executePostGateTask(store, postGateExecutor, executeTask.taskId, fixture.ids.sessionId)
    expect((await store.get(auditTask.taskId, fixture.ids.sessionId))?.status).toBe("queued")
    await executePostGateTask(store, postGateExecutor, auditTask.taskId, fixture.ids.sessionId)
    expect(rpcBodies.map(body => body.action)).toEqual(["scheduled_post_gate_execute", "scheduled_post_gate_audit"])
    const resumed = await continuation({ owner: resumedOwner, executionOwner: resumedExecutionOwner,
      mode: "resume_post_gate", finalStepId: planStep, recoveryStepId: recoveryStep, signal: new AbortController().signal })
    expect(resumed.status).toBe("completed")
    const completion = await command.verifyScheduledPostGateCompletion?.({ scope: readScopeFor(resumedLease, fixture) })
    expect(completion).toMatchObject({ handoff: { owner: { userId: fixture.ids.userId, sessionId: fixture.ids.sessionId,
      turnId: fixture.ids.turnId, rootTaskId: fixture.ids.rootTaskId }, execute: [{ taskId: executeTask.taskId }],
      audit: { taskId: auditTask.taskId, report: zeroReport } } })
    const root = await db.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id"=$1 AND "sessionId"=$2`,
      [fixture.ids.rootTaskId, fixture.ids.sessionId])
    const turn = await db.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id"=$1 AND "sessionId"=$2`,
      [fixture.ids.turnId, fixture.ids.sessionId])
    expect(root.rows[0]?.status).toBeDefined()
    expect(["completed", "failed", "interrupted", "cancelled", "closed"]).not.toContain(root.rows[0]?.status)
    expect(turn.rows[0]?.status).toBe("in_progress")
    expect((await store.get(gateTaskId, fixture.ids.sessionId))?.attemptCount).toBe(1)
  }, 600_000)
})

type ScheduledPostGateReplayDiagnostic = Readonly<{
  available: boolean
  handoffValid: boolean
  acceptedPlan?: Readonly<{ eventCount: number; identity: boolean; fingerprint: boolean; receipt: boolean; nodes: boolean; readyTaskIds: boolean }>
}>

/** Read-only, bounded predicate snapshot used only when duplicate receipt validation fails. */
async function diagnoseScheduledPostGateReplay(pool: Pool, scope: TaskGraphReadScope): Promise<ScheduledPostGateReplayDiagnostic> {
  let client: PoolClient | undefined, inTransaction = false
  try {
    client = await pool.connect()
    await client.query("BEGIN"); inTransaction = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [scope.userId])
    await lockTaskGraphScope(client, scope)
    const loaded = await loadTaskGraph(client, scope)
    const receipt = await readScheduledPostGateReceipt(client, scope)
    if (!receipt || !loaded.snapshot || !loaded.state) return { available: true, handoffValid: false }
    const handoffValid = await validateScheduledPostGateHandoff(client, scope, loaded, receipt)
    const gateIndex = loaded.snapshot.nodes.findIndex(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
    const proposal = { expectedRevision: receipt.gateGraphRevision, nodes: loaded.snapshot.nodes.slice(gateIndex + 1).map(node => ({
      key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria, dependsOn: node.dependsOn,
      ...(node.packageRefs === undefined ? {} : { packageRefs: node.packageRefs }),
    })) }
    const key = taskGraphProposalKey(scope.rootTaskId, receipt.gateGraphRevision)
    const result = await client.query<Record<string, unknown>>(\`SELECT event."itemId", event."taskId", event."actor",
      event."idempotencyKey", event."payload" FROM "agent_events" AS event
      JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" IN ('item.started', 'item.delta')
        AND event."idempotencyKey" = $3 AND session."userId" = $4 AND turn."userId" = $4 LIMIT 2\`,
    [scope.sessionId, scope.turnId, key, scope.userId])
    const event = record(result.rows[0]), payload = event && record(event.payload)
    const planReceipt = payload && record(payload.receipt), planNodes = planReceipt && diagnosticDenseArray(planReceipt.nodes)
    const expectedNodes = [...receipt.executeNodes.map(node => ({ key: node.key, taskId: node.taskId, status: "queued" })),
      { key: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, taskId: receipt.auditTaskId, status: "waiting" }]
    const single = result.rows.length === 1
    return { available: true, handoffValid, acceptedPlan: {
      eventCount: Math.min(result.rows.length, 2),
      identity: Boolean(single && event && event.itemId === taskGraphItemId(scope.rootTaskId)
        && event.taskId === scope.rootTaskId && event.actor === "orchestrator" && event.idempotencyKey === key
        && payload?.kind === "proposal" && payload.revision === receipt.graphRevision),
      fingerprint: Boolean(payload && safeDiagnosticSame(payload.fingerprint, taskGraphFingerprint(proposal))),
      receipt: Boolean(planReceipt && planReceipt.status === "accepted" && planReceipt.revision === receipt.graphRevision),
      nodes: Boolean(planNodes && safeDiagnosticSame(planNodes, expectedNodes)),
      readyTaskIds: Boolean(planReceipt && safeDiagnosticSame(planReceipt.readyTaskIds, receipt.executeNodes.map(node => node.taskId))),
    } }
  } catch {
    return { available: false, handoffValid: false }
  } finally {
    if (client) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  }
}

function diagnosticDenseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string"
    && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) ? value : null
}

function safeDiagnosticSame(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}

function errorCode(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined
  try { return Reflect.get(value, "code") } catch { return undefined }
}

async function adoptRootLease(fixture: Awaited<ReturnType<typeof createScheduledGatePrepareFixture>>, lease: TurnLease,
  rootStore: ReturnType<typeof createPgRootTaskStore>, execution: ReturnType<typeof createCanonicalExecutionProjection>): Promise<void> {
  const root = await rootStore.ensure({ lease, goal: "Complete the scheduled application review safely", allowedActions: rootActions })
  expect(root).toMatchObject({ id: fixture.ids.rootTaskId, status: "running", leaseOwner: lease.ownerId })
  await execution.start({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
}

async function startStep(fixture: Awaited<ReturnType<typeof createScheduledGatePrepareFixture>>, lease: TurnLease,
  store: ReturnType<typeof createPgTurnEngineStore>): Promise<string> {
  const result = await pool!.query<{ ordinal: number | string }>(`SELECT COALESCE(MAX("ordinal"), -1) + 1 AS "ordinal"
    FROM "agent_steps" WHERE "sessionId"=$1 AND "turnId"=$2`, [fixture.ids.sessionId, fixture.ids.turnId])
  const stepId = `scheduled-post-gate-step-${randomUUID()}`
  await store.startStep({ owner: turnFence(lease, fixture.ids.rootTaskId), stepId, ordinal: Number(result.rows[0]?.ordinal),
    attempt: 1, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: { provider: "fixture", model: "scheduled-post-gate" }, now: new Date() })
  return stepId
}

async function seedAgentPlanHistory(client: Pool, lease: TurnLease, rootTaskId: string, stepId: string, revision: number,
  proposal: TaskGraphProposal, callId: string): Promise<void> {
  const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: lease.sessionId, turnId: lease.turnId,
    stepId, inputThroughSequence: 0n, consumedInputIds: [], blocks: [], canonicalJson: "{}", taskGraphRevision: revision }
  const agenda = buildCognitiveAgendaReceipt({ sessionId: lease.sessionId, turnId: lease.turnId, taskId: rootTaskId,
    stepId, inputThroughSequence: 0n, consumedInputIds: [], agenda: buildCognitiveActionAgenda(context) })
  if (!agenda) throw new Error("scheduled_post_gate_agenda_invalid")
  await insertEvent(client, { sessionId: lease.sessionId, turnId: lease.turnId, itemId: null, taskId: rootTaskId,
    type: COGNITIVE_AGENDA_EVENT_TYPE, actor: "orchestrator", correlationId: stepId, idempotencyKey: `cognitive.agenda:${stepId}`, payload: agenda })
  const itemId = `${callId}-item`, content = { toolCallId: callId, toolName: "agent.plan", toolVersion: "1", input: proposal }
  await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "createdAt", "updatedAt")
    VALUES ($1,$2,$3,$4,$5,'tool_call','started',$6::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  [itemId, lease.sessionId, lease.turnId, stepId, rootTaskId, JSON.stringify(content)])
  const identity = { kind: "turn" as const, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    taskId: rootTaskId, rootTaskId, ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt }
  await insertEvent(client, { sessionId: lease.sessionId, turnId: lease.turnId, itemId, taskId: rootTaskId,
    type: "tool_call.started", actor: "orchestrator", correlationId: callId,
    idempotencyKey: `${executionKey(identity)}:event:tool-started:${callId}`, payload: { toolCallId: callId, toolName: "agent.plan", taskId: rootTaskId } })
}

async function insertEvent(client: Pool, event: { sessionId: string; turnId: string; itemId: string | null; taskId: string | null;
  type: string; actor: string; correlationId: string; idempotencyKey: string; payload: unknown }): Promise<void> {
  const updated = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 RETURNING "eventSequence"`, [event.sessionId])
  const sequence = updated.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("scheduled_post_gate_event_sequence_missing")
  await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11::jsonb)`, [randomUUID(), event.sessionId, event.turnId, event.itemId,
    event.taskId, String(sequence), event.type, event.actor, event.correlationId, event.idempotencyKey, JSON.stringify(event.payload)])
}

async function executePostGateTask(store: PgSubagentTaskStore, executor: ReturnType<typeof createScheduledPostGateChildExecutor>,
  taskId: string, sessionId: string): Promise<void> {
  const task = await store.get(taskId, sessionId)
  if (!task) throw new Error("scheduled_post_gate_task_missing")
  const ownerId = `scheduled-post-gate-child-${randomUUID()}`
  const claimed = await store.claim({ taskId, sessionId, ownerId, policy: policyFromTask(task), now: new Date() })
  if (!claimed) throw new Error("scheduled_post_gate_task_claim_missing")
  const lease = leaseFor(claimed, ownerId)
  const result = await executor({ lease, continuation: undefined })
  await finishTask(store, claimed, ownerId, result)
}

async function finishTask(store: PgSubagentTaskStore, claimed: NonNullable<Awaited<ReturnType<PgSubagentTaskStore["claim"]>>>,
  ownerId: string, result: SubagentExecutionResult): Promise<void> {
  if (result.status !== "completed" || result.result === undefined) throw new Error("scheduled_post_gate_child_did_not_complete")
  const finished = await store.finish({ taskId: claimed.id, sessionId: claimed.sessionId, ownerId,
    attemptCount: claimed.attemptCount, status: result.status, result: result.result, now: new Date() })
  if (finished !== "completed") throw new Error("scheduled_post_gate_child_finish_uncommitted")
}

function leaseFor(task: NonNullable<Awaited<ReturnType<PgSubagentTaskStore["claim"]>>>, ownerId: string): SubagentLease {
  if (!(task.leaseExpiresAt instanceof Date)) throw new Error("scheduled_post_gate_child_lease_expiry_missing")
  return { ...task, ownerId, leaseExpiresAt: task.leaseExpiresAt, signal: new AbortController().signal }
}

function turnFence(lease: TurnLease, rootTaskId: string) {
  return { kind: "turn" as const, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    taskId: rootTaskId, rootTaskId, ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt }
}

function readScopeFor(lease: TurnLease, fixture: Awaited<ReturnType<typeof createScheduledGatePrepareFixture>>) {
  return { ...fixture.graphScope, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
    parentLeaseOwner: lease.ownerId, parentAttemptCount: fixture.owner.rootAttemptCount }
}

async function findTaskId(client: Pool, rootTaskId: string, taskType: string): Promise<string> {
  const result = await client.query<{ id: string }>(`SELECT "id" FROM "sub_agent_tasks" WHERE "rootTaskId"=$1 AND "taskType"=$2`, [rootTaskId, taskType])
  if (result.rows.length !== 1) throw new Error("scheduled_post_gate_task_identity_missing")
  return result.rows[0]!.id
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : {} }
  catch { return {} }
}

function jsonResponse(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }) }
function restoreEnv(key: string, value: string | undefined): void { if (value === undefined) delete process.env[key]; else process.env[key] = value }

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") return null
  const url = new URL(value)
  return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "5432"
    && url.username === "postgres" && url.password === "postgres" && url.pathname === "/applymate_agent_brain_ci"
    && !url.search && !url.hash ? value : null
}

function disposableRedisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value || process.env.CI !== "true" || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true") return null
  const url = new URL(value)
  return url.protocol === "redis:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    && url.port === "6379" && url.pathname === "/15" && !url.username && !url.password && !url.search && !url.hash ? value : null
}
