import { createHash, randomUUID } from "node:crypto"
import { Queue, Worker } from "bullmq"
import Redis from "ioredis"
import type { Pool } from "pg"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { WorkerUsageAuthorizationInput, WorkerUsageSettlementInput } from "../../queue/ai-usage-bridge.js"
import { type TurnLease } from "../turns/lease.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { createPgTurnQuestionStore } from "../turns/turn-question-store.js"
import { scheduledPrepareChoiceWaitId } from "../turns/turn-question-contract.js"
import { drainAgentWakeups } from "../wakeup/consumer.js"
import { AGENT_TURN_WAKEUP_TOPIC } from "../wakeup/types.js"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { createScheduledAutomationPrepareContinuation } from "./scheduled-automation-prepare-bridge.js"
import { verifyScheduledPrepareTaskGraphEvidence } from "./scheduled-prepare-task-graph-verification.js"
import { createScheduledAutomationPipelineBridge, type ScheduledAutomationPipelineAttestation,
  type ScheduledAutomationPipelineBridgeState, type ScheduledAutomationPipelineOwner } from "./scheduled-automation-pipeline-bridge.js"
import { postScheduledPipelineContinuation, scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { runSubagentQueueJob } from "../../queue/subagent-pause-dispatch.js"
import { parseSubagentDispatchJobId } from "./dispatch-identity.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import type { PgSubagentPool, SubagentJobPayload } from "./types.js"
import type { TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"
import { createScheduledPipelineCandidateStore, withScheduledPipelineCandidateModelOutput } from "./scheduled-pipeline-candidate-store.js"
import { createScheduledTaskGraphContinuationContract } from "./scheduled-taskgraph-continuation-receipt.js"
import { scheduledGatePreparedJobIds } from "./scheduled-gate-contract.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type { ScheduledPipelineAnalyzeCheckpointProof } from "./scheduled-pipeline-handoff.js"
import { seedScheduledGatePrepareFixture, type ScheduledGatePrepareSeedFixture } from "./scheduled-gate-prepare-pg.fixture.js"
import { digestScheduledAnalyzeCheckpoint, graphScope, resumePrepareChoice, scheduledGateRootActions, turnExecutionOwner,
  SCHEDULED_GATE_BASE_RESUME, type ScheduledGatePrepareOwner } from "./scheduled-gate-prepare-pg-resume.fixture.js"

const WAIT_MS = 30_000
const LETTER = "Fixture cover letter prepared for the scheduled Gate integration test."
const DB_PATH = "@/lib/db"
const GATE_SERVICE_PATH = "@/lib/agent/scheduled-taskgraph-run-service"

export type ScheduledGatePrepareFixtureOptions = Readonly<{ jobCount?: number }>
export type ScheduledGatePrepareFixture = Readonly<{
  ids: ScheduledGatePrepareSeedFixture["ids"] & { prepareTaskId: string; gateTaskId?: string }
  jobIds: readonly string[]; jobRecords: ScheduledGatePrepareSeedFixture["jobRecords"]
  snapshot: ScheduledGatePrepareSeedFixture["snapshot"]; scheduleSnapshot: ScheduledGatePrepareSeedFixture["scheduleSnapshot"]
  graphScope: ScheduledGatePrepareSeedFixture["graphScopeV1"]
  owner: ScheduledGatePrepareOwner; turnLease: TurnLease; turnExecutionOwner: {
    kind: "turn"; userId: string; sessionId: string; turnId: string; taskId: string; rootTaskId: string
    ownerId: string; leaseVersion: number; leaseExpiresAt: Date
  }
  executionOwner: ScheduledGatePrepareSeedFixture["executionOwner"]
  attestation: ScheduledAutomationPipelineAttestation; prepareProof: ScheduledPrepareTaskGraphProof; prepareWaitId: string
  preparedJobIds: readonly string[]; continuationKey: string; handoff: ScheduledPipelineAnalyzeCheckpointProof
  /** Historical answered Prepare-choice step and wait; never use the step as a current Gate wait step. */
  rootQuestionStepId: string; rootQuestionWaitId: string; prepareChoiceWaitId: string
  checkpointStage: "gate"; reattestCurrentTurn(lease: TurnLease): Promise<ScheduledAutomationPipelineAttestation>
}>

/** Runs the actual verified Analyze → Prepare path and leaves its Gate checkpoint in PostgreSQL. */
export async function createScheduledGatePrepareFixture(pool: Pool, redisUrl: string,
  options: ScheduledGatePrepareFixtureOptions = {}): Promise<ScheduledGatePrepareFixture> {
  if (options.jobCount !== undefined && (!Number.isSafeInteger(options.jobCount) || options.jobCount < 1 || options.jobCount > 10)) {
    throw new RangeError("scheduled_gate_prepare_job_count_invalid")
  }
  const seed = await seedScheduledGatePrepareFixture(pool, { jobCount: options.jobCount ?? 1 })
  const bridge = createBridge(pool, seed)
  const analyze = await bridge(seed.ownerV1)
  if (analyze.status !== "ready") throw new Error(`scheduled_gate_prepare_analyze_${analyze.reasonCode}`)
  const attestationV1 = analyze.attestation, executionOwner = seed.executionOwner
  const initialContinuationKey = scheduledTaskGraphContinuationKey(seed.ownerV1, attestationV1,
    executionOwner.executionId, executionOwner.executionAttemptCount)
  const claimToken = `scheduled-gate-prepare-claim-${randomUUID()}`
  const claimOwner = { ...seed.ownerV1, ...executionOwner }
  const checkpointState = analyzeCheckpoint(seed, claimOwner, claimToken, initialContinuationKey, attestationV1)
  const checkpointDigest = await digestScheduledAnalyzeCheckpoint(checkpointState)
  await pool.query(`INSERT INTO "agent_executions"
    ("id", "userId", "sessionId", "status", "checkpoint", "state", "attemptCount", "startedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, 'running', 'prepare', $4::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [executionOwner.executionId, seed.ids.userId, seed.ids.sessionId, JSON.stringify(checkpointState)])
  await pool.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "createdAt", "updatedAt")
    VALUES ($1, $2, 'Fixture Base Resume', $3::jsonb, 'base', 'manual', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [`scheduled-gate-resume-${seed.ids.turnId}`, seed.ids.userId, JSON.stringify(SCHEDULED_GATE_BASE_RESUME)])
  const stepOrdinal = Number((await pool.query<{ ordinal: number | string }>(`SELECT COALESCE(MAX("ordinal"), -1) + 1 AS "ordinal" FROM "agent_steps" WHERE "turnId"=$1 AND "sessionId"=$2`, [seed.ids.turnId, seed.ids.sessionId])).rows[0]?.ordinal)
  if (!Number.isSafeInteger(stepOrdinal) || stepOrdinal < 0) throw new Error("scheduled_gate_prepare_step_ordinal_invalid")
  const stepId = `scheduled-gate-prepare-step-${seed.ids.turnId}`
  const candidateText = "Scheduled Gate integration candidate."
  const usage = { inputTokens: 37, outputTokens: 9, estimatedCostUsd: 0.018 }
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
    VALUES ($1, $2, $3, $4, $5, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [stepId, seed.ids.sessionId, seed.ids.turnId, seed.ids.rootTaskId, stepOrdinal])
  const initialTurnExecutionOwner = turnExecutionOwner(seed, seed.turnLeaseV1)
  const candidateStore = createScheduledPipelineCandidateStore(pool as never, createPgTurnEngineStore(pool as never))
  await withScheduledPipelineCandidateModelOutput({ owner: initialTurnExecutionOwner, finalStepId: stepId, finalStepOrdinal: stepOrdinal,
    candidateText, finishReason: "stop", usage }, () => candidateStore.stage({ owner: initialTurnExecutionOwner,
    rootAttemptCount: seed.ownerV1.rootAttemptCount, finalStepId: stepId, finalStepOrdinal: stepOrdinal, candidateText }))
  const prepare = await waitForPrepareChoice(pool, seed, attestationV1, initialContinuationKey, claimToken, checkpointDigest,
    stepId, stepOrdinal, candidateText, usage, initialTurnExecutionOwner)
  const resumed = await resumePrepareChoice(pool, seed, { owner: seed.ownerV1 as ScheduledGatePrepareOwner,
    attestation: attestationV1, executionOwner, continuationKey: initialContinuationKey, choiceWaitId: prepare.choiceWaitId,
    nextTurnRevision: prepare.nextTurnRevision, answer: "keep_resume", allowedActions: scheduledGateRootActions() })
  const currentOwner = resumed.owner, currentScope = graphScope(seed, currentOwner)
  const continuationKey = resumed.handoff.continuationKey
  const analyzeAgain = await bridge(currentOwner)
  if (analyzeAgain.status !== "ready") throw new Error(`scheduled_gate_prepare_rebind_${analyzeAgain.reasonCode}`)
  const ready = await runPrepare(pool, redisUrl, seed, currentOwner, resumed.turnExecutionOwner,
    analyzeAgain.attestation, resumed.handoff, stepId, stepOrdinal, candidateText)
  const gate = await buildAndPersistGateCheckpoint(pool, seed, currentOwner, analyzeAgain.attestation, continuationKey,
    resumed.handoff, resumed.claimToken, ready.prepareProof, prepare.choiceWaitId)
  const preparedIds = scheduledGatePreparedJobIds(ready.prepareProof)
  if (!preparedIds) throw new Error("scheduled_gate_prepare_prepared_job_ids_invalid")
  return { ids: { ...seed.ids, prepareTaskId: ready.prepareTaskId }, jobIds: seed.jobIds, jobRecords: seed.jobRecords,
    snapshot: seed.snapshot, scheduleSnapshot: seed.scheduleSnapshot, graphScope: currentScope, owner: currentOwner,
    turnLease: resumed.turnLease, turnExecutionOwner: resumed.turnExecutionOwner, executionOwner,
    attestation: analyzeAgain.attestation, prepareProof: ready.prepareProof, prepareWaitId: ready.prepareWaitId,
    continuationKey, handoff: resumed.handoff, rootQuestionStepId: stepId, rootQuestionWaitId: prepare.choiceWaitId,
    prepareChoiceWaitId: prepare.choiceWaitId,
    preparedJobIds: preparedIds, checkpointStage: gate === "gate" ? "gate" : fail("scheduled_gate_checkpoint_missing"),
    async reattestCurrentTurn(lease) {
      const reboundOwner = { ...currentOwner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
      const result = await bridge(reboundOwner)
      if (result.status !== "ready") throw new Error(`scheduled_gate_prepare_reattest_${result.reasonCode}`)
      return result.attestation
    } }
}

function createBridge(pool: Pool, seed: ScheduledGatePrepareSeedFixture) {
  return createScheduledAutomationPipelineBridge({
    async load(scope): Promise<ScheduledAutomationPipelineBridgeState> {
      const turn = (await pool.query(`SELECT "id" AS "turnId", "userId", "sessionId", "rootTaskId", "source", "executionMode", "input", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3`, [scope.turnId, scope.userId, scope.sessionId])).rows[0]
      const root = (await pool.query(`SELECT task."id", session."userId", task."sessionId", task."turnId", task."status", task."attemptCount" FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id"=task."sessionId" WHERE task."id"=$1 AND task."sessionId"=$2 AND task."turnId"=$3 AND session."userId"=$4`, [scope.rootTaskId, scope.sessionId, scope.turnId, scope.userId])).rows[0]
      const graph = await loadTaskGraph(pool as never, graphScope(seed, scope), false), current = currentTaskGraph(graph)
      const tasks = (await pool.query<ScheduledAutomationPipelineBridgeState["tasks"][number]>(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."role", task."taskType", task."status", task."attemptCount", task."failureReason", task."expectedOutputSchema", task."allowedActions", task."result"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = ANY($1::text[]) AND task."sessionId"=$2 AND task."turnId"=$3 AND task."rootTaskId"=$4 AND session."userId"=$5`,
      [current.nodes.map(node => node.taskId), scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])).rows
      if (!turn || !root || tasks.length < 2) throw new Error("scheduled_gate_prepare_owner_rows_missing")
      return { turn, root, snapshot: graph.snapshot, current, tasks }
    },
    async verifyCompletedNode(input) { return verifyCompletedTaskGraphNodeEvidence(pool as never, input) },
  })
}

function analyzeCheckpoint(seed: ScheduledGatePrepareSeedFixture, owner: ScheduledAutomationPipelineOwner,
  claimToken: string, continuationKey: string, attestation: ScheduledAutomationPipelineAttestation): Record<string, unknown> {
  const lease = seed.turnLeaseV1
  return { nextStage: "prepare", scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1",
    key: continuationKey, claimToken, owner, claimedAt: lease.leaseStartedAt.toISOString(), leaseExpiresAt: lease.leaseExpiresAt.toISOString() },
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key: continuationKey,
      owner, snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision, evidenceDigest: attestation.evidenceDigest },
    scoutedJobs: seed.jobRecords, scoredJobs: seed.scoredJobs, analysisFailed: 0 }
}
async function waitForPrepareChoice(pool: Pool, seed: ScheduledGatePrepareSeedFixture,
  attestation: ScheduledAutomationPipelineAttestation, continuationKey: string, claimToken: string, checkpointDigest: string,
  stepId: string, stepOrdinal: number, candidateText: string, usage: Readonly<{ inputTokens: number; outputTokens: number; estimatedCostUsd: number }>,
  turnOwner: TurnExecutionOwnerFence): Promise<{ choiceWaitId: string; nextTurnRevision: number }> {
  const proof: ScheduledPipelineAnalyzeCheckpointProof = { status: "analyze_checkpointed", continuationKey, checkpointDigest,
    claimTokenDigest: `sha256:${createHash("sha256").update(claimToken, "utf8").digest("hex")}`,
    executionId: seed.executionOwner.executionId, executionAttemptCount: seed.executionOwner.executionAttemptCount }
  const scope = { ...graphScope(seed, seed.ownerV1), stepId }
  const input: TaskGraphScheduledPrepareInput = { scope, executionOwner: seed.executionOwner, handoff: proof, attestation,
    proposal: { expectedRevision: attestation.graphRevision, nodes: [{ key: "prepare", templateId: "prepare",
      goal: "Prepare application materials using the persisted scheduled Analyze checkpoint.", successCriteria: [
        "Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
        "Persist immutable owner-fenced material references and return no resume or letter bodies.",
      ], dependsOn: ["scheduled-analyst"] }] } }
  const contract = createScheduledTaskGraphContinuationContract(input)
  if (!contract) throw new Error("scheduled_gate_prepare_choice_contract_invalid")
  const waitId = scheduledPrepareChoiceWaitId({ receipt: contract.receipt, finalStepId: stepId, finalStepOrdinal: stepOrdinal })
  if (!waitId) throw new Error("scheduled_gate_prepare_choice_wait_id_invalid")
  const command = createPgTaskGraphCommandPort(pool as never), waitPort = createPgDurableWaitPort(pool as never)
  const continuation = createScheduledAutomationPrepareContinuation({ commandPort: command, waitPort })
  const waiting = await continuation({ owner: seed.ownerV1, executionOwner: turnOwner, attestation, proof,
    candidateText, finalStepId: stepId, finalStepOrdinal: stepOrdinal, signal: new AbortController().signal })
  if (waiting.status !== "waiting_for_choice" || waiting.waitId !== waitId) throw new Error("scheduled_gate_prepare_choice_not_waiting")
  const question = await createPgTurnQuestionStore(pool as never).waitForQuestion({ owner: turnOwner, stepId,
    toolCallId: null, expectedWaitId: waitId, finishReason: "stop", usage, now: new Date() })
  if (question.status !== "waiting_for_user" || question.waitId !== waitId) throw new Error("scheduled_gate_prepare_question_not_persisted")
  return { choiceWaitId: waitId, nextTurnRevision: question.nextTurnRevision }
}

async function runPrepare(pool: Pool, redisUrl: string, seed: ScheduledGatePrepareSeedFixture,
  owner: ScheduledAutomationPipelineOwner, turnOwner: TurnExecutionOwnerFence,
  attestation: ScheduledAutomationPipelineAttestation, proof: ScheduledPipelineAnalyzeCheckpointProof,
  stepId: string, stepOrdinal: number, candidateText: string): Promise<{ prepareTaskId: string; prepareWaitId: string; prepareProof: ScheduledPrepareTaskGraphProof }> {
  const scope = { ...graphScope(seed, owner), stepId }, command = createPgTaskGraphCommandPort(pool as never)
  const waitPort = createPgDurableWaitPort(pool as never)
  const continuation = createScheduledAutomationPrepareContinuation({ commandPort: command, waitPort,
    async verifyReadyPrepare({ scope: verifyScope, prepareTaskId }) {
      const graph = await loadTaskGraph(pool as never, verifyScope, false), current = currentTaskGraph(graph)
      const task = graph.tasks.get(prepareTaskId)
      if (!graph.snapshot || !task || !Number.isSafeInteger(task.attemptCount)) return { verified: false, reasonCode: "scheduled_prepare_graph_invalid" }
      return verifyScheduledPrepareTaskGraphEvidence(pool as never, { scope: { ...verifyScope, taskId: prepareTaskId, attemptCount: task.attemptCount! },
        snapshot: graph.snapshot, current, tasks: graph.tasks, structuredResult: (task.result as Record<string, unknown> | null)?.structuredResult,
        completionGraphRevision: current.revision, referenceVerificationMode: { phase: "persisted_gate" } })
    } })
  const input = { owner, executionOwner: turnOwner, attestation, proof, candidateText, finalStepId: stepId,
    finalStepOrdinal: stepOrdinal, signal: new AbortController().signal }
  const waiting = await continuation(input)
  if (waiting.status !== "waiting_for_dependency") throw new Error("scheduled_gate_prepare_dependency_not_waiting")
  const graph = await command.readCurrent(scope), prepare = graph.nodes.find(node => node.key === "prepare")
  if (!prepare?.taskId) throw new Error("scheduled_gate_prepare_task_missing")
  await executePrepareChild(pool, redisUrl, seed, prepare.taskId)
  const resolution = await waitPort.resolve({ userId: seed.ids.userId, sessionId: seed.ids.sessionId, waitId: waiting.waitId })
  if (!resolution || resolution.status !== "ready" || !resolution.matchedTaskIds.includes(prepare.taskId)) throw new Error("scheduled_gate_prepare_wait_unresolved")
  const ready = await continuation(input)
  if (ready.status !== "ready" || ready.prepareProof.completion.wait.waitId !== waiting.waitId) throw new Error("scheduled_gate_prepare_proof_missing")
  return { prepareTaskId: prepare.taskId, prepareWaitId: waiting.waitId, prepareProof: ready.prepareProof }
}

async function executePrepareChild(pool: Pool, redisUrl: string, seed: ScheduledGatePrepareSeedFixture, taskId: string): Promise<void> {
  const { dispatchPendingSubagentOutbox, subagentJobId } = await import("../../queue/subagent-queue.js")
  const [runtime, store, managerModule] = await Promise.all([import("./production-child-runtime.js"), import("./pg-store.js"), import("./manager.js")])
  const profile: ModelAdapter["profile"] = { provider: "fixture", model: "scheduled-gate-prepare", nativeTools: true,
    structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false,
    supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false,
    supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null,
    maxOutputTokens: 2200, costClass: "low" }
  const modelRuntimeFactory = (): ModelAdapter => ({ id: "scheduled-gate-prepare-fixture", profile,
    async *stream(request) {
      const parts = request.messages.flatMap(message => message.content), result = parts.find(part => part.type === "tool_result")
      if (request.tools.some(tool => (tool as { name?: unknown }).name === "scheduled.application.prepare")) {
        if (!result || result.type !== "tool_result") {
          yield { type: "tool_call_completed", callId: `scheduled-prepare-tool-${taskId}`, name: "scheduled.application.prepare", arguments: {} }
          yield { type: "completed", finishReason: "tool_calls" }; return
        }
        if (result.isError) throw new Error("scheduled Prepare tool returned an error")
        yield { type: "text_delta", text: result.content }; yield { type: "completed", finishReason: "stop" }; return
      }
      const prompt = parts.filter(part => part.type === "text").map(part => part.text).join("\n")
      const text = prompt.includes("Tailor this resume") ? JSON.stringify(SCHEDULED_GATE_BASE_RESUME)
        : prompt.includes("Write a concise, professional European application cover letter") ? LETTER : null
      if (!text) throw new Error("scheduled Prepare fixture received an unexpected material prompt")
      yield { type: "text_delta", text }; yield { type: "completed", finishReason: "stop" }
    } })
  const authorizeUsage = async (_input: WorkerUsageAuthorizationInput) => ({ settle: async (_value: WorkerUsageSettlementInput) => undefined })
  const executor = runtime.createProductionChildExecutor({ pool: pool as never, authorizeUsage, modelRuntimeFactory })
  const manager = new managerModule.AgentTreeManager(new store.PgSubagentTaskStore(pool as never))
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 2_000, retryStrategy: attempt => attempt > 3 ? null : 100 })
  const connection = redis.duplicate(), queueName = `scheduled-gate-prepare-${randomUUID()}`
  const queue = new Queue<SubagentJobPayload>(queueName, { connection, skipVersionCheck: true })
  let worker: Worker<SubagentJobPayload, unknown> | undefined
  try {
    await redis.ping(); await queue.waitUntilReady()
    await dispatchPendingSubagentOutbox(pool as never, queue, 10, seed.ids.sessionId)
    worker = new Worker<SubagentJobPayload, unknown>(queueName, async job => {
      const identity = parseSubagentDispatchJobId(job.id, job.data.taskId)
      if (!identity) throw new Error("scheduled Prepare dispatch identity invalid")
      return runSubagentQueueJob(pool as never, manager, executor, job.data, identity)
    }, { connection: redis.duplicate(), skipVersionCheck: true, concurrency: 1 })
    const completed = waitForChild(worker, subagentJobId(taskId))
    await worker.waitUntilReady()
    const outcome = await completed
    if (!outcome || typeof outcome !== "object" || (outcome as { status?: unknown }).status !== "completed") {
      throw new Error("scheduled Prepare child did not complete")
    }
  } finally {
    await worker?.close().catch(() => undefined)
    const job = await queue.getJob(subagentJobId(taskId)).catch(() => undefined)
    await job?.remove().catch(() => undefined)
    await queue.close().catch(() => undefined)
    await connection.quit().catch(() => connection.disconnect())
    await redis.quit().catch(() => redis.disconnect())
  }
}

function waitForChild(worker: Worker<SubagentJobPayload, unknown>, jobId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`scheduled Prepare child timed out: ${jobId}`)), WAIT_MS)
    worker.on("completed", job => { if (job.id === jobId) { clearTimeout(timer); resolve(job.returnvalue) } })
    worker.on("failed", (job, error) => { if (job?.id === jobId) { clearTimeout(timer); reject(error) } })
  })
}

async function buildAndPersistGateCheckpoint(pool: Pool, seed: ScheduledGatePrepareSeedFixture,
  owner: ScheduledAutomationPipelineOwner, attestation: ScheduledAutomationPipelineAttestation, continuationKey: string,
  handoff: ScheduledPipelineAnalyzeCheckpointProof, claimToken: string, prepareProof: ScheduledPrepareTaskGraphProof,
  scheduledWaitId: string): Promise<"gate" | null> {
  const web = await import(DB_PATH) as unknown as { db: { job: { findMany(input: unknown): Promise<unknown[]> }; $disconnect(): Promise<void> } }
  const service = await import(GATE_SERVICE_PATH) as unknown as {
    buildScheduledTaskGraphGateResumeState(input: { owner: ScheduledAutomationPipelineOwner & ScheduledGatePrepareSeedFixture["executionOwner"];
      snapshot: unknown; attestation: unknown; continuationKey: string; claimToken: string; ownedJobs: readonly unknown[];
      persistedCheckpoint: unknown; prepareProof: unknown; scheduledWaitId: string }): Promise<Record<string, unknown>>
  }
  try {
    const checkpoint = (await pool.query<{ state: unknown }>(`SELECT "state" FROM "agent_executions" WHERE "id"=$1`, [seed.executionOwner.executionId])).rows[0]
    if (!checkpoint) throw new Error("scheduled Gate execution checkpoint missing")
    const jobs = await web.db.job.findMany({ where: { id: { in: seed.jobIds }, userId: seed.ids.userId } })
    if (jobs.length !== seed.jobIds.length) throw new Error("scheduled Gate owned jobs missing")
    const state = await service.buildScheduledTaskGraphGateResumeState({ owner: { ...owner, ...seed.executionOwner },
      snapshot: seed.scheduleSnapshot, attestation, continuationKey, claimToken, ownedJobs: jobs,
      persistedCheckpoint: checkpoint.state, prepareProof, scheduledWaitId })
    if (state.nextStage !== "gate") throw new Error("scheduled Gate resume projection invalid")
    await pool.query(`UPDATE "agent_executions" SET "checkpoint"='gate', "state"=$2::jsonb, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      [seed.executionOwner.executionId, JSON.stringify(state)])
    return "gate"
  } finally { await web.db.$disconnect() }
}

function fail(message: string): never { throw new Error(message) }
