import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import { type TurnLease } from "../turns/lease.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { drainAgentWakeups } from "../wakeup/consumer.js"
import { AGENT_TURN_WAKEUP_TOPIC } from "../wakeup/types.js"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { createScheduledAutomationPrepareContinuation } from "./scheduled-automation-prepare-bridge.js"
import { verifyScheduledPrepareTaskGraphEvidence } from "./scheduled-prepare-task-graph-verification.js"
import { createScheduledAutomationPipelineBridge, type ScheduledAutomationPipelineAttestation,
  type ScheduledAutomationPipelineBridgeState, type ScheduledAutomationPipelineOwner } from "./scheduled-automation-pipeline-bridge.js"
import { postScheduledPipelineContinuation, scheduledTaskGraphContinuationKey, type ScheduledPipelineAnalyzeCheckpointProof } from "./scheduled-pipeline-handoff.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { scheduledGatePreparedJobIds } from "./scheduled-gate-contract.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import { seedScheduledGatePrepareFixture, type ScheduledGatePrepareSeedFixture } from "./scheduled-gate-prepare-pg.fixture.js"
import { digestScheduledAnalyzeCheckpoint, graphScope, resumePrepareChoice, scheduledGateRootActions,
  SCHEDULED_GATE_BASE_RESUME, type ScheduledGatePrepareOwner } from "./scheduled-gate-prepare-pg-resume.fixture.js"
import { executeScheduledGatePrepareChild } from "./scheduled-gate-prepare-child-runner.fixture.js"
import { runScheduledGatePrepareRootQuestion } from "./scheduled-gate-prepare-root-turn.fixture.js"

const DB_PATH = "@/lib/db"
const GATE_SERVICE_PATH = "@/lib/agent/scheduled-taskgraph-run-service"

export type ScheduledGatePrepareFixtureOptions = Readonly<{ jobCount?: number; scoutCount?: number; selectedJobCount?: number }>
export type ScheduledGatePrepareFixture = Readonly<{
  ids: ScheduledGatePrepareSeedFixture["ids"] & { prepareTaskId: string; gateTaskId?: string }
  jobIds: readonly string[]; selectedJobIds: readonly string[]; jobRecords: ScheduledGatePrepareSeedFixture["jobRecords"]
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
  const seed = await seedScheduledGatePrepareFixture(pool, { jobCount: options.jobCount ?? 1,
    ...(options.scoutCount === undefined ? {} : { scoutCount: options.scoutCount }),
    ...(options.selectedJobCount === undefined ? {} : { selectedJobCount: options.selectedJobCount }) })
  const bridge = createBridge(pool, seed)
  const analyze = await bridge(seed.ownerV1)
  if (analyze.status !== "ready") throw new Error(`scheduled_gate_prepare_analyze_${analyze.reasonCode}`)
  const attestationV1 = analyze.attestation, executionOwner = seed.executionOwner
  const initialContinuationKey = scheduledTaskGraphContinuationKey(seed.ownerV1, attestationV1,
    executionOwner.executionId, executionOwner.executionAttemptCount)
  const claimToken = `scheduled-gate-prepare-claim-${randomUUID()}`
  const claimOwner = { ...seed.ownerV1, ...executionOwner }
  const resumeId = `scheduled-gate-resume-${seed.ids.turnId}`
  await pool.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "createdAt", "updatedAt")
    VALUES ($1, $2, 'Fixture Base Resume', $3::jsonb, 'base', 'manual', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [resumeId, seed.ids.userId, JSON.stringify(SCHEDULED_GATE_BASE_RESUME)])
  const sourceFingerprintsByJob = await readAnalyzeSourceFingerprints(pool, seed, resumeId)
  const checkpointState = analyzeCheckpoint(seed, claimOwner, claimToken, initialContinuationKey, attestationV1, sourceFingerprintsByJob)
  const checkpointDigest = await digestScheduledAnalyzeCheckpoint(checkpointState)
  await pool.query(`INSERT INTO "agent_executions"
    ("id", "userId", "sessionId", "status", "checkpoint", "state", "attemptCount", "startedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, 'running', 'prepare', $4::jsonb, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [executionOwner.executionId, seed.ids.userId, seed.ids.sessionId, JSON.stringify(checkpointState)])
  const prepare = await runScheduledGatePrepareRootQuestion({ pool, seed, owner: seed.ownerV1, attestation: attestationV1,
    continuationKey: initialContinuationKey, checkpointDigest, claimToken, bridge })
  const resumed = await resumePrepareChoice(pool, seed, { owner: seed.ownerV1 as ScheduledGatePrepareOwner,
    attestation: attestationV1, executionOwner, continuationKey: initialContinuationKey, choiceWaitId: prepare.choiceWaitId,
    nextTurnRevision: prepare.nextTurnRevision, answer: "keep_resume", allowedActions: scheduledGateRootActions() })
  const currentOwner = resumed.owner, currentScope = graphScope(seed, currentOwner)
  const continuationKey = resumed.handoff.continuationKey
  const analyzeAgain = await bridge(currentOwner)
  if (analyzeAgain.status !== "ready") throw new Error(`scheduled_gate_prepare_rebind_${analyzeAgain.reasonCode}`)
  const ready = await runPrepare(pool, redisUrl, seed, currentOwner, resumed.turnExecutionOwner,
    analyzeAgain.attestation, resumed.handoff, prepare.stepId, prepare.stepOrdinal, prepare.candidateText)
  const gate = await buildAndPersistGateCheckpoint(pool, seed, currentOwner, analyzeAgain.attestation, continuationKey,
    resumed.handoff, resumed.claimToken, ready.prepareProof, prepare.choiceWaitId)
  const preparedIds = scheduledGatePreparedJobIds(ready.prepareProof)
  if (!preparedIds) throw new Error("scheduled_gate_prepare_prepared_job_ids_invalid")
  return { ids: { ...seed.ids, prepareTaskId: ready.prepareTaskId }, jobIds: seed.jobIds, selectedJobIds: seed.selectedJobIds,
    jobRecords: seed.jobRecords,
    snapshot: seed.snapshot, scheduleSnapshot: seed.scheduleSnapshot, graphScope: currentScope, owner: currentOwner,
    turnLease: resumed.turnLease, turnExecutionOwner: resumed.turnExecutionOwner, executionOwner,
    attestation: analyzeAgain.attestation, prepareProof: ready.prepareProof, prepareWaitId: ready.prepareWaitId,
    continuationKey, handoff: resumed.handoff, rootQuestionStepId: prepare.stepId, rootQuestionWaitId: prepare.choiceWaitId,
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
  claimToken: string, continuationKey: string, attestation: ScheduledAutomationPipelineAttestation,
  sourceFingerprintsByJob: Readonly<Record<string, Readonly<{ version: string; digest: string }>>>): Record<string, unknown> {
  const lease = seed.turnLeaseV1
  const selectedJobRecords = seed.jobRecords.filter(job => seed.selectedJobIds.includes(job.id))
  return { nextStage: "prepare", scheduledTaskGraphClaim: { schemaVersion: "agent-harness.v2.scheduled-pipeline-claim.v1",
    key: continuationKey, claimToken, owner, claimedAt: lease.leaseStartedAt.toISOString(), leaseExpiresAt: lease.leaseExpiresAt.toISOString() },
    scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", key: continuationKey,
      owner, snapshotDigest: attestation.snapshotDigest, graphRevision: attestation.graphRevision, evidenceDigest: attestation.evidenceDigest },
    scoutedJobs: selectedJobRecords, scoredJobs: seed.scoredJobs, analysisFailed: 0,
    scheduledTaskGraphAnalyzeSourceFingerprints: sourceFingerprintsByJob }
}
async function readAnalyzeSourceFingerprints(pool: Pool, seed: ScheduledGatePrepareSeedFixture, resumeId: string):
  Promise<Readonly<Record<string, Readonly<{ version: string; digest: string }>>>> {
  const scoredJobIds = seed.scoredJobs.map(scored => scored.job.id)
  if (new Set(scoredJobIds).size !== scoredJobIds.length) throw new Error("scheduled_gate_prepare_scored_job_ids_invalid")
  const sourceJobsResult = await pool.query<{ id: string; userId: string; company: string; role: string; location: string | null;
    description: string | null; source: string | null; url: string | null }>(`SELECT "id", "userId", "company", "role", "location", "description", "source", "url"
      FROM "Job" WHERE "userId"=$1 AND "id"=ANY($2::text[])`, [seed.ids.userId, scoredJobIds])
  const sourceJobsById = new Map(sourceJobsResult.rows.map(job => [job.id, job]))
  if (sourceJobsById.size !== scoredJobIds.length) throw new Error("scheduled_gate_prepare_scored_job_source_missing")
  const resumeResult = await pool.query<{ id: string; content: unknown }>(`SELECT "id", "content" FROM "Resume"
    WHERE "id"=$1 AND "userId"=$2 AND "isDefault"=true`, [resumeId, seed.ids.userId])
  const resume = resumeResult.rows[0]
  if (!resume) throw new Error("scheduled_gate_prepare_default_resume_missing")
  const analyzeSourceModulePath = "@/lib/agent/stages/analyze-model-input"
  const analyzeSourceModule = await import(analyzeSourceModulePath) as unknown as {
    createAnalyzeSourceFingerprint(input: { userId: string; jobId: string
      job: { company: string; role: string; location: string | null; description: string | null; source: string | null; url: string | null }
      resumeId: string; resumeText: string }): { version: string; digest: string }
  }
  const resumeTypesModulePath = "@/lib/agent/types"
  const resumeTypesModule = await import(resumeTypesModulePath) as unknown as { resumeToText(content: unknown): string }
  const resumeText = resumeTypesModule.resumeToText(resume.content).slice(0, 2000)
  return Object.fromEntries(scoredJobIds.map(jobId => {
    const job = sourceJobsById.get(jobId)
    if (!job) throw new Error("scheduled_gate_prepare_scored_job_source_missing")
    return [jobId, analyzeSourceModule.createAnalyzeSourceFingerprint({ userId: seed.ids.userId, jobId,
      job: { company: job.company, role: job.role, location: job.location, description: job.description, source: job.source, url: job.url },
      resumeId: resume.id, resumeText })]
  }))
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
    finalStepOrdinal: stepOrdinal, recoveryStepId: stepId, signal: new AbortController().signal }
  const waiting = await continuation(input)
  if (waiting.status !== "waiting_for_dependency") throw new Error("scheduled_gate_prepare_dependency_not_waiting")
  const graph = await command.readCurrent(scope), prepare = graph.nodes.find(node => node.key === "prepare")
  if (!prepare?.taskId) throw new Error("scheduled_gate_prepare_task_missing")
  await executeScheduledGatePrepareChild(pool, redisUrl, seed, prepare.taskId)
  const resolution = await waitPort.resolve({ userId: seed.ids.userId, sessionId: seed.ids.sessionId, waitId: waiting.waitId })
  if (!resolution || resolution.status !== "ready" || !resolution.matchedTaskIds.includes(prepare.taskId)) throw new Error("scheduled_gate_prepare_wait_unresolved")
  const ready = await continuation(input)
  if (ready.status !== "ready" || ready.prepareProof.completion.wait.waitId !== waiting.waitId) throw new Error("scheduled_gate_prepare_proof_missing")
  return { prepareTaskId: prepare.taskId, prepareWaitId: waiting.waitId, prepareProof: ready.prepareProof }
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
    const jobs = await web.db.job.findMany({ where: { id: { in: seed.selectedJobIds }, userId: seed.ids.userId } })
    if (jobs.length !== seed.selectedJobIds.length) throw new Error("scheduled Gate owned jobs missing")
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
