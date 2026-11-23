import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { AgentExecutionCancelledError } from "./execution-control"
import { scheduledSourceChangeTaskClaims, terminalizeScheduledAnalyzeSourceChangedTasks } from "./scheduled-taskgraph-source-change-task-cleanup"
import { buildScheduledTaskGraphSourceChangeTerminalState, isScheduledTaskGraphSourceChangeTerminal } from "./scheduled-taskgraph-source-change-terminal"
import { isAnalyzeSourceChangedError, readAnalyzeSourceChangedClaims } from "./stages/analyze-model-input"
import { acquireScheduledTaskGraphGateSourceFence, assertScheduledTaskGraphGateSourcesCurrent, isScheduledTaskGraphGateSourceChangedError, isScheduledTaskGraphGateSourceProofInvalidError, scheduledTaskGraphGateRecord } from "./scheduled-taskgraph-gate-source"
import { lockScheduledTaskGraphRootAction, scheduledGateRootWaitWitnessMatches } from "./scheduled-taskgraph-gate-root-wait"
import { scheduledTaskGraphGateTaskLeaseIsCurrent, scheduledTaskGraphGateTurnIsCurrent, type ScheduledTaskGraphGateRequestOwner } from "./scheduled-taskgraph-gate-rpc"
import { scheduledTaskGraphClaimIsValid, scheduledTaskGraphLineageOwnerIsSame, blocked, gateFailureDiagnostic, matchingTurnSnapshot } from "./scheduled-taskgraph-pipeline-request"
import { scheduledTaskGraphClaimMatches } from "./scheduled-taskgraph-pipeline-fence"
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import { inspectScheduledTaskGraphGateInput, isScheduledTaskGraphGateProofCurrent } from "./scheduled-taskgraph-gate-input"
import { scheduledTaskGraphPrepareWaitId, validateScheduledTaskGraphAuditPrepareSource } from "./scheduled-taskgraph-audit-action"
import { validateScheduledPrepareWaitIdentity } from "./scheduled-taskgraph-run-service"
import { scheduledGateWaitAttemptMatchesCurrentHistory } from "./scheduled-taskgraph-gate-root-wait"
import { createScheduledTaskGraphGateMaterialDriftError, isScheduledTaskGraphGateMaterialDriftTerminal, readScheduledTaskGraphGateMaterialDriftProof, persistScheduledTaskGraphGateMaterialDriftTerminal, scheduledTaskGraphGateMaterialDriftProofMatches } from "./scheduled-taskgraph-gate-material-drift"
const SOURCE_CHANGED_ERROR = "scheduled_pipeline_source_changed", MATERIAL_DRIFT_ERROR = "scheduled_prepare_material_source_changed"
const CONTINUATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-continuation.v1"
const SNAPSHOT_DIGEST = /^sha256:[a-f0-9]{64}$/
const CONTINUATION_KEY = /^scheduled-taskgraph:(?:v2:)?sha256:[a-f0-9]{64}$/
const TERMINALIZATION_CANCELLED = Symbol("scheduled_gate_source_terminal_cancelled")
type Result = "terminalized" | "owner_changed" | "gate_task_changed" | "snapshot_changed" | "source_current" | "state_changed" | "not_confirmed" | "cancelled"
type SessionRow = { id: string; status: string }
type TurnRow = { id: string; userId: string; sessionId: string; rootTaskId: string | null; source: string; executionMode: string | null; input: unknown; status: string; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | null }
type GateTaskRow = Record<string, unknown>
type ExecutionRow = { id: string; status: string; attemptCount: number; state: unknown; error: string | null }
export type ScheduledTaskGraphGateSourceTerminalInput = Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  key: string
  claimToken: string
  attestationSnapshotDigest: string
  attestation: unknown
  prepareProof: unknown
  scheduledWaitId?: string
  gate: Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>
  sourceChangeError: unknown
  signal?: AbortSignal
}>
type GateFailureRequest = Readonly<{ attestation: unknown; prepareProof: unknown; scheduledWaitId?: string; gateTaskId: string; gateLeaseOwnerId: string; gateAttemptCount: number }>
type LockedGateFailureOwner = Readonly<{ owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string; snapshot: unknown }>
/** Maps only recognized Gate source failures; drift is reported only after a committed terminalization. */
export async function respondToScheduledTaskGraphGateSourceFailure(input: Readonly<{ error: unknown; request: GateFailureRequest;
  locked?: LockedGateFailureOwner | null; signal?: AbortSignal }>): Promise<Response | null> {
  if (isScheduledTaskGraphGateSourceProofInvalidError(input.error)) return blocked(409, "scheduled_pipeline_attestation_invalid")
  if (!isScheduledTaskGraphGateSourceChangedError(input.error)) return null
  if (!input.locked) return blocked(409, "scheduled_pipeline_turn_stale")
  let digest: string
  try { digest = scheduledAutomationSnapshotDigest(parseScheduledAutomationSnapshot(input.locked.snapshot)) }
  catch { return blocked(409, "scheduled_pipeline_snapshot_mismatch") }
  return respondToScheduledTaskGraphGateSourceChange({ ...input.locked, attestationSnapshotDigest: digest,
    attestation: input.request.attestation, prepareProof: input.request.prepareProof,
    ...(input.request.scheduledWaitId ? { scheduledWaitId: input.request.scheduledWaitId } : {}),
    gate: { taskId: input.request.gateTaskId, leaseOwnerId: input.request.gateLeaseOwnerId,
      attemptCount: input.request.gateAttemptCount }, sourceChangeError: input.error, signal: input.signal })
}
export async function respondToScheduledTaskGraphGateActionFailure(input: Readonly<{ error: unknown; request: GateFailureRequest;
  locked?: LockedGateFailureOwner | null; signal?: AbortSignal; phase: "owner_assertion" | "gate_execution"; rethrowUnknown?: boolean }>): Promise<Response> {
  if (readScheduledTaskGraphGateMaterialDriftProof(input.error)) {
    if (!input.locked) return blocked(409, "scheduled_pipeline_turn_stale")
    let digest: string
    try { digest = scheduledAutomationSnapshotDigest(parseScheduledAutomationSnapshot(input.locked.snapshot)) }
    catch { return blocked(409, "scheduled_pipeline_snapshot_mismatch") }
    return respondToScheduledTaskGraphGateSourceChange({ ...input.locked, attestationSnapshotDigest: digest,
      attestation: input.request.attestation, prepareProof: input.request.prepareProof,
      gate: { taskId: input.request.gateTaskId, leaseOwnerId: input.request.gateLeaseOwnerId,
        attemptCount: input.request.gateAttemptCount }, sourceChangeError: input.error, signal: input.signal })
  }
  const sourceFailure = await respondToScheduledTaskGraphGateSourceFailure(input)
  if (sourceFailure) return sourceFailure
  if (input.rethrowUnknown) throw input.error
  const cancelled = input.error instanceof AgentExecutionCancelledError
  return blocked(cancelled ? 409 : 500, cancelled ? "scheduled_pipeline_turn_stale" : "scheduled_pipeline_execution_failed",
    gateFailureDiagnostic(input.phase, input.error))
}
/** Runs only after the source-fenced Gate transaction has rolled back. */
export async function terminalizeScheduledTaskGraphGateSourceChange(input: ScheduledTaskGraphGateSourceTerminalInput): Promise<Result> {
  const materialProof = readScheduledTaskGraphGateMaterialDriftProof(input.sourceChangeError)
  if (!validInput(input) || (!materialProof && (!isAnalyzeSourceChangedError(input.sourceChangeError)
    || readAnalyzeSourceChangedClaims(input.sourceChangeError) === null))) return "not_confirmed"
  try { if (scheduledTaskGraphContinuationKey(input.owner, input.attestation) !== input.key) return "not_confirmed" }
  catch { return "not_confirmed" }
  if (input.signal?.aborted) return "cancelled"
  return db.$transaction(async tx => {
    await acquireScheduledTaskGraphGateSourceFence(tx, input.owner.userId, input.owner.userId)
    if (input.signal?.aborted) return "cancelled"
    const sessions = await tx.$queryRaw<SessionRow[]>(Prisma.sql`
      SELECT "id", "status" FROM "agent_sessions"
      WHERE "id" = ${input.owner.sessionId} AND "userId" = ${input.owner.userId}
      FOR UPDATE
    `)
    if (sessions.length !== 1 || sessions[0]?.id !== input.owner.sessionId
      || ["aborted", "archived"].includes(sessions[0]?.status ?? "")) return "owner_changed"
    const turns = await tx.$queryRaw<TurnRow[]>(Prisma.sql`
      SELECT "id", "userId", "sessionId", "rootTaskId", "source", "executionMode", "input", "status",
        "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns"
      WHERE "id" = ${input.owner.turnId} AND "userId" = ${input.owner.userId}
        AND "sessionId" = ${input.owner.sessionId} AND "rootTaskId" = ${input.owner.rootTaskId}
        AND "source" = 'automation' AND "executionMode" = 'canonical_task_graph'
      FOR UPDATE
    `)
    const turn = turns[0], requestOwner = gateRequestOwner(input.owner)
    if (turns.length !== 1 || !turn || turn.id !== input.owner.turnId || turn.userId !== input.owner.userId
      || turn.sessionId !== input.owner.sessionId || turn.rootTaskId !== input.owner.rootTaskId
      || !scheduledTaskGraphGateTurnIsCurrent(turn, { owner: requestOwner, mode: "gate_child" })) return "owner_changed"
    let snapshot: ReturnType<typeof matchingTurnSnapshot>
    try { snapshot = matchingTurnSnapshot(turn.input) } catch { return "snapshot_changed" }
    if (!snapshot) return "snapshot_changed"
    try { snapshot = parseScheduledAutomationSnapshot(snapshot) } catch { return "snapshot_changed" }
    let liveDigest: string
    try { liveDigest = scheduledAutomationSnapshotDigest(snapshot) } catch { return "snapshot_changed" }
    if (liveDigest !== input.attestationSnapshotDigest) return "snapshot_changed"
    const rootLock = await lockScheduledTaskGraphRootAction(tx, { owner: requestOwner, action: "gate", turn,
      gateTaskId: input.gate.taskId })
    if (!rootLock) return "owner_changed"
    if (rootLock.gateWait) {
      const witness = { ...rootLock.gateWait, owner: input.owner }
      if (!scheduledGateRootWaitWitnessMatches({ owner: input.owner, gateTaskId: input.gate.taskId,
        root: rootLock.root, witness })) return "owner_changed"
    }
    if (input.signal?.aborted) return "cancelled"
    const gateTasks = await tx.$queryRaw<GateTaskRow[]>(Prisma.sql`
      SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "depth", "role", "taskType", "status",
        "attemptCount", "leaseOwner", "leaseExpiresAt", "interruptRequestedAt", "closedAt", "expectedOutputSchema", "allowedActions"
      FROM "sub_agent_tasks" WHERE "id" = ${input.gate.taskId} AND "sessionId" = ${input.owner.sessionId}
        AND "turnId" = ${input.owner.turnId} AND "rootTaskId" = ${input.owner.rootTaskId}
        AND "parentTaskId" = ${input.owner.rootTaskId} AND "depth" = 1
        AND "status" = 'running' AND "attemptCount" = ${input.gate.attemptCount}
        AND "leaseOwner" = ${input.gate.leaseOwnerId} AND "leaseExpiresAt" > clock_timestamp()
        AND "interruptRequestedAt" IS NULL AND "closedAt" IS NULL
      FOR UPDATE
    `)
    if (gateTasks.length !== 1 || !scheduledTaskGraphGateTaskLeaseIsCurrent(gateTasks[0], { owner: requestOwner,
      taskId: input.gate.taskId, leaseOwnerId: input.gate.leaseOwnerId, attemptCount: input.gate.attemptCount })) return "gate_task_changed"
    if (input.signal?.aborted) return "cancelled"
    const executions = await tx.$queryRaw<ExecutionRow[]>(Prisma.sql`
      SELECT "id", "status", "attemptCount", "state", "error" FROM "agent_executions"
      WHERE "id" = ${input.owner.executionId} AND "userId" = ${input.owner.userId}
        AND "sessionId" = ${input.owner.sessionId}
      FOR UPDATE
    `)
    const execution = executions[0]
    if (executions.length !== 1 || !execution || execution.id !== input.owner.executionId
      || execution.attemptCount !== input.owner.executionAttemptCount) return "owner_changed"
    const terminalState = { owner: input.owner, status: execution.status, error: execution.error, state: execution.state }
    if (materialProof ? isScheduledTaskGraphGateMaterialDriftTerminal({ ...terminalState, gate: input.gate })
      : isScheduledTaskGraphSourceChangeTerminal(terminalState)) return "terminalized"
    if (execution.status !== "running") return "state_changed"
    const state = scheduledTaskGraphGateRecord(execution.state), claim = scheduledTaskGraphGateRecord(state?.scheduledTaskGraphClaim)
    const continuation = scheduledTaskGraphGateRecord(state?.scheduledTaskGraphContinuation)
    if (!state || !claim || !continuation || claim.key !== input.key || claim.claimToken !== input.claimToken
      || !scheduledTaskGraphClaimIsValid(claim, input.owner, input.key, input.claimToken)
      || !scheduledTaskGraphClaimMatches(state, input.key, input.owner, input.claimToken)
      || continuation.schemaVersion !== CONTINUATION_SCHEMA || continuation.key !== input.key
      || continuation.snapshotDigest !== liveDigest || !scheduledTaskGraphLineageOwnerIsSame(continuation.owner, input.owner)) return "not_confirmed"
    const waitId = scheduledTaskGraphPrepareWaitId({ owner: requestOwner, scheduledWaitId: input.scheduledWaitId }, state, snapshot.requireApproval)
    if (waitId === null) return "not_confirmed"
    const gateRootWait = rootLock.gateWait ? { ...rootLock.gateWait, owner: input.owner } : undefined
    const proofCurrent = await isScheduledTaskGraphGateProofCurrent({ owner: input.owner, snapshot, analyzeCheckpoint: state,
      analyzeAttestation: input.attestation, prepareProof: input.prepareProof,
      gate: { taskId: input.gate.taskId, attemptCount: input.gate.attemptCount, phase: "running" },
      ...(gateRootWait ? { gateRootWait } : {}) }, tx)
    const prepareIsCurrent = gateRootWait && snapshot.requireApproval
      ? await validateScheduledTaskGraphAuditPrepareSource({ owner: input.owner, snapshot, proof: input.prepareProof,
        ...(waitId ? { scheduledWaitId: waitId } : {}), reader: tx, gateWait: gateRootWait })
      : await validateScheduledPrepareWaitIdentity({ owner: input.owner, snapshot, proof: input.prepareProof,
        ...(waitId ? { scheduledWaitId: waitId } : {}) })
    if (!proofCurrent || !prepareIsCurrent) return "not_confirmed"
    if (rootLock.gateWait && !await scheduledGateWaitAttemptMatchesCurrentHistory(tx, requestOwner, input.gate.taskId,
      rootLock.gateWait.requestAttemptCount)) return "not_confirmed"
    try { await assertScheduledTaskGraphGateSourcesCurrent(tx, { owner: input.owner, checkpoint: state }) }
    catch (error) {
      if (!isScheduledTaskGraphGateSourceChangedError(error)) throw error
      return materialProof ? "source_current" : finalize(input, tx, execution, state, liveDigest)
    }
    if (materialProof) {
      const inspection = await inspectScheduledTaskGraphGateInput({ owner: input.owner, snapshot, analyzeCheckpoint: state,
        analyzeAttestation: input.attestation, prepareProof: input.prepareProof,
        gate: { taskId: input.gate.taskId, attemptCount: input.gate.attemptCount, phase: "running" },
        ...(gateRootWait ? { gateRootWait } : {}) }, tx)
      if (inspection.kind !== "material_source_drift") return inspection.kind === "valid" ? "source_current" : "not_confirmed"
      const refreshed = createScheduledTaskGraphGateMaterialDriftError({ owner: input.owner, gate: input.gate,
        snapshotDigest: liveDigest, analyzeCheckpoint: state, prepareProof: input.prepareProof, evidence: inspection.evidence })
      const refreshedProof = readScheduledTaskGraphGateMaterialDriftProof(refreshed)
      if (!refreshedProof || !scheduledTaskGraphGateMaterialDriftProofMatches(materialProof, refreshedProof)) return "not_confirmed"
      return finalizeMaterialDrift(input, tx, execution, state, liveDigest, materialProof)
    }
    return "source_current"
  })
}
async function finalizeMaterialDrift(input: ScheduledTaskGraphGateSourceTerminalInput, tx: Prisma.TransactionClient,
  execution: ExecutionRow, state: Record<string, unknown>, liveDigest: string,
  proof: NonNullable<ReturnType<typeof readScheduledTaskGraphGateMaterialDriftProof>>): Promise<Result> {
  if (input.signal?.aborted) return "cancelled"
  const result = await persistScheduledTaskGraphGateMaterialDriftTerminal({ tx, owner: input.owner, gate: input.gate,
    executionId: execution.id, executionAttemptCount: input.owner.executionAttemptCount, snapshotDigest: liveDigest,
    expectedState: state, proof })
  if (result !== "terminalized") return result
  if (input.signal?.aborted) throw TERMINALIZATION_CANCELLED
  return "terminalized"
}
async function finalize(input: ScheduledTaskGraphGateSourceTerminalInput, tx: Prisma.TransactionClient,
  execution: ExecutionRow, state: Record<string, unknown>, liveDigest: string): Promise<Result> {
  if (input.signal?.aborted) return "cancelled"
  const claims = scheduledSourceChangeTaskClaims(input.sourceChangeError, state)
  const nextState = buildScheduledTaskGraphSourceChangeTerminalState({ owner: input.owner,
    attestationSnapshotDigest: liveDigest, expectedState: state })
  if (!claims || !nextState) return "not_confirmed"
  const saved = await tx.agentExecution.updateMany({ where: { id: execution.id, userId: input.owner.userId,
    sessionId: input.owner.sessionId, status: "running", attemptCount: input.owner.executionAttemptCount,
    state: { equals: state as Prisma.InputJsonValue } },
    data: { status: "failed", error: SOURCE_CHANGED_ERROR, completedAt: new Date(), state: nextState as Prisma.InputJsonValue } })
  if (saved.count !== 1) return "state_changed"
  if (input.signal?.aborted) throw TERMINALIZATION_CANCELLED
  if (claims.length) await terminalizeScheduledAnalyzeSourceChangedTasks(tx, {
    userId: input.owner.userId, sessionId: input.owner.sessionId, claims,
  })
  return "terminalized"
}
export async function respondToScheduledTaskGraphGateSourceChange(input: ScheduledTaskGraphGateSourceTerminalInput): Promise<Response> {
  try {
    const result = await terminalizeScheduledTaskGraphGateSourceChange(input)
    if (result === "terminalized") return blocked(409, readScheduledTaskGraphGateMaterialDriftProof(input.sourceChangeError) ? MATERIAL_DRIFT_ERROR : SOURCE_CHANGED_ERROR)
    if (result === "owner_changed") return blocked(409, "scheduled_pipeline_turn_stale")
    if (result === "gate_task_changed") return blocked(409, "scheduled_pipeline_gate_task_stale")
    if (result === "snapshot_changed") return blocked(409, "scheduled_pipeline_snapshot_mismatch")
    if (result === "source_current") return blocked(503, "scheduled_pipeline_handoff_retryable")
    if (result === "cancelled") return blocked(409, "scheduled_pipeline_turn_stale")
    return blocked(409, "scheduled_pipeline_claim_conflict")
  } catch (error) {
    if (error === TERMINALIZATION_CANCELLED) return blocked(409, "scheduled_pipeline_turn_stale")
    return blocked(500, "scheduled_pipeline_execution_failed")
  }
}
function gateRequestOwner(owner: ScheduledTaskGraphPipelineOwner): ScheduledTaskGraphGateRequestOwner {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }
}
function validInput(input: ScheduledTaskGraphGateSourceTerminalInput): boolean {
  const owner = input.owner, gate = input.gate
  return Boolean(owner && [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId,
    gate?.taskId, gate?.leaseOwnerId, input.key, input.claimToken].every(validId)
    && positive(owner.rootAttemptCount) && positive(owner.turnLeaseVersion) && nonNegative(owner.executionAttemptCount)
    && positive(gate.attemptCount) && CONTINUATION_KEY.test(input.key) && SNAPSHOT_DIGEST.test(input.attestationSnapshotDigest))
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
