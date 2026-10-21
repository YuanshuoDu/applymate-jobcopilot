import { createHash } from "node:crypto"
import { Prisma, type Job } from "@prisma/client"
import { db } from "@/lib/db"
import { AgentExecutionCancelledError } from "./execution-control"
import { runScheduledTaskGraphAnalyze, scheduledTaskGraphScoreOwnerIsCurrent } from "./scheduled-taskgraph-analysis-journal"
import { buildScheduledTaskGraphGateCheckpoint, scheduledTaskGraphAnalyzeCheckpointDigest, type ScheduledTaskGraphPreparedPackageRow } from "./scheduled-taskgraph-gate-checkpoint"
import { loadScheduledTaskGraphGateInput, scheduledTaskGraphAnalyzeCheckpointForGate } from "./scheduled-taskgraph-gate-input"
import { buildScheduledTaskGraphPrepareCheckpoint, scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import { isScheduledTaskGraphOwnerCurrent, saveScheduledTaskGraphCheckpoint, scheduledTaskGraphClaimMatches } from "./scheduled-taskgraph-pipeline-fence"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import type { PipelineCtx } from "./pipeline-context"
import type { GateOutput, PipelineCheckpointState, PipelineStage } from "./types"

export type ScheduledTaskGraphAnalyzeCheckpointProof = Readonly<{ status: "analyze_checkpointed"; continuationKey: string; checkpointDigest: string; claimTokenDigest: string; executionId: string; executionAttemptCount: number }>
export type ScheduledTaskGraphAnalyzeOnlyInput = Readonly<{ owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; attestation: unknown; continuationKey: string; claimToken: string;
  ownedJobs: readonly Job[]; context: PipelineCtx; state: unknown; onStateChange: (state: unknown) => void }>
export type ScheduledTaskGraphGateResumeInput = Readonly<{ owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; attestation: unknown; continuationKey: string;
  claimToken: string; ownedJobs: readonly Job[]; persistedCheckpoint: unknown; prepareProof: unknown; scheduledWaitId?: string }>

const CHOICE_SCHEMA = "agent-harness.v2.scheduled-prepare-choice-wait.v1"
const RECEIPT_EVENT = "agent.plan.scheduled_prepare_binding"
const CANDIDATE_EVENT = "native_verification.scheduled_candidate_staged"
const CHOICE_CONTENT = { waitKind: "question", toolCallId: null, stage: "scheduled_prepare",
  question: "How should ApplyMate tailor your resume for this role?",
  options: [{ label: "Apply AI changes", value: "apply_ai_changes" }, { label: "Keep my current resume", value: "keep_resume" }] }
export function isScheduledPrepareChoiceWaitId(turnId: string, value: unknown): value is string { const prefix = `agent-question:${turnId}:canonical:`; return typeof value === "string" && value.startsWith(prefix) && /^[a-f0-9]{64}$/.test(value.slice(prefix.length)) }
/** Validates the separate Worker choice wait against its private receipt and persisted final step. */
export async function validateScheduledPrepareWaitIdentity(input: Readonly<{
  owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; proof: unknown; scheduledWaitId?: string
}>): Promise<boolean> {
  let snapshot: ReturnType<typeof parseScheduledAutomationSnapshot>
  try { snapshot = parseScheduledAutomationSnapshot(input.snapshot) } catch { return false }
  const proof = exactRecord(input.proof, ["receipt", "completion", "result"]), receipt = parseChoiceReceipt(proof?.receipt, input.owner)
  if (!receipt || receipt.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot)
    || (snapshot.requireApproval ? !isScheduledPrepareChoiceWaitId(input.owner.turnId, input.scheduledWaitId) : input.scheduledWaitId !== undefined)) return false
  const [receipts, candidates] = await Promise.all([
    db.agentEvent.findMany({ where: { sessionId: input.owner.sessionId, turnId: input.owner.turnId, type: RECEIPT_EVENT, itemId: null, taskId: null, actor: "system" }, select: { payload: true }, take: 65 }),
    db.agentEvent.findMany({ where: { sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.rootTaskId, type: CANDIDATE_EVENT },
      orderBy: { sequence: "desc" }, select: { type: true, taskId: true, correlationId: true, payload: true }, take: 65 }),
  ])
  if (receipts.length >= 65 || candidates.length >= 65 || receipts.filter(row => sameCanonicalJson(row.payload, receipt)).length !== 1) return false
  const latest = await db.agentStep.findFirst({ where: { sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.rootTaskId },
    orderBy: { ordinal: "desc" }, select: { id: true } })
  const matching = candidates.flatMap(row => {
    const candidate = parseChoiceCandidate(row.payload, row.type, row.taskId, row.correlationId, input.owner)
    return candidate && (snapshot.requireApproval ? scheduledChoiceId(receipt, candidate.finalStepId, candidate.finalStepOrdinal) === input.scheduledWaitId
      : candidate.finalStepId === latest?.id) ? [candidate] : []
  })
  if (matching.length !== 1 || !latest) return false
  const candidate = matching[0]!, waitId = scheduledChoiceId(receipt, candidate.finalStepId, candidate.finalStepOrdinal)
  if (snapshot.requireApproval && waitId !== input.scheduledWaitId) return false
  const itemId = `agent-wait:question:${waitId}`
  const [step, item] = await Promise.all([
    db.agentStep.findFirst({ where: { id: candidate.finalStepId, sessionId: input.owner.sessionId, turnId: input.owner.turnId,
      taskId: input.owner.rootTaskId, attempt: 1, ordinal: candidate.finalStepOrdinal }, select: { id: true, status: true } }),
    db.agentItem.findFirst({ where: { id: itemId, sessionId: input.owner.sessionId, turnId: input.owner.turnId },
      select: { id: true, stepId: true, taskId: true, type: true, status: true, content: true } }),
  ])
  if (!step || latest.id !== candidate.finalStepId || !["streaming", "waiting_for_user", "waiting_for_tool", "completed"].includes(step.status)) return false
  if (!snapshot.requireApproval) return item === null
  if (!item) return false
  const content = exactRecord(item.content, ["waitKind", "questionId", "toolCallId", "stage", "question", "options", "answer", "answerAvailable", "scheduledPrepareChoiceBinding"])
  const binding = choiceBinding(receipt, candidate.finalStepId, candidate.finalStepOrdinal)
  return Boolean(item.id === itemId && item.stepId === candidate.finalStepId && item.taskId === input.owner.rootTaskId && item.type === "question"
    && content && content.questionId === input.scheduledWaitId
    && sameCanonicalJson({ waitKind: content.waitKind, toolCallId: content.toolCallId, stage: content.stage, question: content.question, options: content.options }, CHOICE_CONTENT)
    && sameCanonicalJson(content.scheduledPrepareChoiceBinding, binding)
    && item.status === "completed" && content.answerAvailable === true && ["apply_ai_changes", "keep_resume"].includes(String(content.answer)))
}
function parseChoiceReceipt(value: unknown, expected: ScheduledTaskGraphPipelineOwner): Record<string, unknown> | null {
  const keys = ["schemaVersion", "owner", "continuationKey", "snapshotDigest", "evidenceDigest", "checkpointDigest", "analyzeGraphRevision", "prepareScheduleRevision"]
  const row = exactRecord(value, keys), owner = exactRecord(row?.owner, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"])
  if (!row || !owner || row.schemaVersion !== "agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1"
    || !sameStableOwner(owner, expected) || typeof row.continuationKey !== "string" || !/^scheduled-taskgraph:sha256:[a-f0-9]{64}$/.test(row.continuationKey)
    || typeof row.snapshotDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.snapshotDigest)
    || !isHex(row.evidenceDigest) || !isHex(row.checkpointDigest) || !positive(row.analyzeGraphRevision)
    || !positive(row.prepareScheduleRevision) || row.prepareScheduleRevision !== Number(row.analyzeGraphRevision) + 1) return null
  return row
}
function parseChoiceCandidate(value: unknown, type: unknown, taskId: unknown, correlationId: unknown, owner: ScheduledTaskGraphPipelineOwner) {
  const row = exactRecord(value, ["schemaVersion", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "finalStepId", "finalStepOrdinal", "stepAttempt", "candidateText", "finishReason", "usage"])
  const usage = row?.usage === null ? null : exactRecord(row?.usage, ["inputTokens", "outputTokens", "estimatedCostUsd"])
  if (!row || type !== CANDIDATE_EVENT || taskId !== owner.rootTaskId || row.schemaVersion !== "agent-harness.v2.scheduled-pipeline-candidate.v2"
    || row.sessionId !== owner.sessionId || row.turnId !== owner.turnId || row.rootTaskId !== owner.rootTaskId || row.rootAttemptCount !== owner.rootAttemptCount
    || !validId(row.finalStepId) || row.finalStepId !== correlationId || !nonNegative(row.finalStepOrdinal) || row.stepAttempt !== 1
    || typeof row.candidateText !== "string" || !row.candidateText.trim() || typeof row.finishReason !== "string" || !row.finishReason.trim()
    || row.usage !== null && (!usage || !nonNegative(usage.inputTokens) || !nonNegative(usage.outputTokens) || typeof usage.estimatedCostUsd !== "number" || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0)) return null
  return { finalStepId: row.finalStepId, finalStepOrdinal: Number(row.finalStepOrdinal) }
}
function choiceBinding(receipt: Record<string, unknown>, finalStepId: string, finalStepOrdinal: number): Record<string, unknown> {
  const owner = receipt.owner as Record<string, unknown>
  return { schemaVersion: CHOICE_SCHEMA, owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount },
    continuationKey: receipt.continuationKey, snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest,
    checkpointDigest: receipt.checkpointDigest, analyzeGraphRevision: receipt.analyzeGraphRevision, prepareScheduleRevision: receipt.prepareScheduleRevision,
    finalStepId, finalStepOrdinal, finalStepAttempt: 1 }
}
function scheduledChoiceId(receipt: Record<string, unknown>, stepId: string, ordinal: number): string {
  const binding = choiceBinding(receipt, stepId, ordinal), owner = binding.owner as Record<string, unknown>
  const projection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId,
    owner.executionAttemptCount, binding.continuationKey, binding.snapshotDigest, binding.evidenceDigest, binding.checkpointDigest,
    binding.analyzeGraphRevision, binding.prepareScheduleRevision, stepId, ordinal, 1]
  return `agent-question:${String(owner.turnId)}:canonical:${createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")}`
}
function sameStableOwner(a: Record<string, unknown>, b: ScheduledTaskGraphPipelineOwner): boolean { return ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"].every(key => a[key] === b[key as keyof ScheduledTaskGraphPipelineOwner]) }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null { const row = record(value); return row && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key)) ? row : null }
function sameCanonicalJson(a: unknown, b: unknown): boolean { try { return canonicalJson(a) === canonicalJson(b) } catch { return false } }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const row = record(value); return row ? `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}` : JSON.stringify(value) }
function isHex(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
/** Rebuilds a private Gate/Execute state from a verified Worker proof and owner-scoped artifact rows. */
export async function buildScheduledTaskGraphGateResumeState(input: ScheduledTaskGraphGateResumeInput): Promise<PipelineCheckpointState> {
  const { owner, continuationKey, claimToken } = input
  const persisted = record(input.persistedCheckpoint), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
  const analyzeCheckpoint = scheduledTaskGraphAnalyzeCheckpointForGate(input.persistedCheckpoint)
  const persistedWaitId = persisted?.scheduledTaskGraphScheduledWaitId
  if (!analyzeCheckpoint || scheduledTaskGraphContinuationKey(owner, input.attestation) !== continuationKey
    || (snapshot.requireApproval ? persistedWaitId !== undefined && persistedWaitId !== input.scheduledWaitId : persistedWaitId !== undefined || input.scheduledWaitId !== undefined)
    || !await isScheduledTaskGraphOwnerCurrent(owner, continuationKey, claimToken)) throw new AgentExecutionCancelledError()
  if (!await validateScheduledPrepareWaitIdentity({ owner, snapshot, proof: input.prepareProof, scheduledWaitId: input.scheduledWaitId })) throw new AgentExecutionCancelledError()
  const loaded = await loadScheduledTaskGraphGateInput({ owner, snapshot: input.snapshot,
    analyzeCheckpoint, analyzeAttestation: input.attestation, prepareProof: input.prepareProof })
  if (!loaded) throw new AgentExecutionCancelledError()
  const handoff = buildScheduledTaskGraphGateCheckpoint({
    analyze: { owner, snapshot: input.snapshot, attestation: input.attestation, ownedJobs: input.ownedJobs,
      persistedCheckpoint: analyzeCheckpoint, activeClaimToken: claimToken },
    proof: input.prepareProof, packages: loaded.packages, materials: loaded.materials,
  })
  if (!handoff || !await isScheduledTaskGraphOwnerCurrent(owner, continuationKey, claimToken)) throw new AgentExecutionCancelledError()
  if (!persisted) throw new AgentExecutionCancelledError()
  const artifactRefs = loaded.materials.map(({ jobId, kind, artifactRef }) => ({ jobId, kind, artifactRef }))
  if (persisted?.scheduledTaskGraphPreparedArtifacts !== undefined
    && !sameJson(persisted.scheduledTaskGraphPreparedArtifacts, artifactRefs)) throw new AgentExecutionCancelledError()
  const requestedStage = pipelineStage(persisted?.nextStage)
  if (!requestedStage || !["prepare", "gate", "execute", "audit"].includes(requestedStage)) throw new AgentExecutionCancelledError()
  const decisions = parseGateDecisions(persisted?.scheduledTaskGraphGateDecisions)
  const gateOutput = decisions ? restoreGateOutput(decisions, loaded.packages) : undefined
  if (["execute", "audit"].includes(requestedStage) && !gateOutput) throw new AgentExecutionCancelledError()
  return {
    ...handoff.checkpoint,
    nextStage: requestedStage === "execute" || requestedStage === "audit" ? requestedStage : "gate",
    ...(typeof persisted?.startedAt === "string" ? { startedAt: persisted.startedAt } : {}),
    ...(Number.isSafeInteger(persisted?.eventIndex) && Number(persisted.eventIndex) >= 0 ? { eventIndex: Number(persisted.eventIndex) } : {}),
    ...(typeof persisted?.autonomous === "boolean" ? { autonomous: persisted.autonomous } : {}),
    ...(Array.isArray(persisted?.customAgentResults) ? { customAgentResults: persisted.customAgentResults as PipelineCheckpointState["customAgentResults"] } : {}),
    ...(persisted?.executeOutput && typeof persisted.executeOutput === "object" ? { executeOutput: persisted.executeOutput as PipelineCheckpointState["executeOutput"] } : {}),
    scheduledTaskGraphPreparedArtifacts: artifactRefs,
    ...(snapshot.requireApproval ? { scheduledTaskGraphScheduledWaitId: input.scheduledWaitId! } : {}),
    ...(decisions ? { scheduledTaskGraphGateDecisions: decisions } : {}),
    ...(gateOutput ? { gateOutput } : {}),
    preparedPackages: [...handoff.packages],
  }
}

/** Removes private artifact bodies before any scheduled checkpoint write. */
export function serializeScheduledTaskGraphCheckpoint(value: PipelineCheckpointState): PipelineCheckpointState | null {
  try {
    const state: PipelineCheckpointState = { ...value,
      ...(value.scoutedJobs ? { scoutedJobs: value.scoutedJobs.map(job => ({ ...job, coverLetter: null })) } : {}),
      ...(value.scoredJobs ? { scoredJobs: value.scoredJobs.map(score => ({ ...score, job: { ...score.job, coverLetter: null } })) } : {}),
    }
    delete state.preparedPackages
    const stage = pipelineStage(state.nextStage)
    if (!stage) return null
    if (stageOrder(stage) > stageOrder("gate") && value.gateOutput) {
      const decisions = gateDecisionsFromOutput(value.gateOutput)
      if (!decisions || (state.scheduledTaskGraphGateDecisions && !sameJson(state.scheduledTaskGraphGateDecisions, decisions))) return null
      state.scheduledTaskGraphGateDecisions = decisions
    }
    delete state.gateOutput
    return state
  } catch { return null }
}

type ScheduledTaskGraphGateDecisions = NonNullable<PipelineCheckpointState["scheduledTaskGraphGateDecisions"]>
function gateDecisionsFromOutput(value: GateOutput): ScheduledTaskGraphGateDecisions | null {
  return parseGateDecisions({ approvedJobIds: value.approved.map(pkg => pkg.job.id),
    pendingJobIds: value.pending.map(pkg => pkg.job.id), skippedJobIds: value.skipped.map(pkg => pkg.job.id) })
}
function parseGateDecisions(value: unknown): ScheduledTaskGraphGateDecisions | null {
  const row = record(value), keys = ["approvedJobIds", "pendingJobIds", "skippedJobIds"]
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return null
  const lists = keys.map(key => row[key])
  if (lists.some(list => !Array.isArray(list) || !list.every(id => typeof id === "string" && id.length > 0 && id.trim() === id)
    || new Set(list as string[]).size !== (list as string[]).length)) return null
  return { approvedJobIds: [...lists[0] as string[]], pendingJobIds: [...lists[1] as string[]], skippedJobIds: [...lists[2] as string[]] }
}
function restoreGateOutput(decisions: ScheduledTaskGraphGateDecisions, packages: readonly ScheduledTaskGraphPreparedPackageRow[]): GateOutput | null {
  const byId = new Map(packages.map(row => [row.jobId, row.package]))
  const ids = [...decisions.approvedJobIds, ...decisions.pendingJobIds, ...decisions.skippedJobIds]
  if (ids.length !== byId.size || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) return null
  return { approved: decisions.approvedJobIds.map(id => byId.get(id)!), pending: decisions.pendingJobIds.map(id => byId.get(id)!),
    skipped: decisions.skippedJobIds.map(id => byId.get(id)!) }
}
function pipelineStage(value: unknown): PipelineStage | null {
  return typeof value === "string" && ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"].includes(value)
    ? value as PipelineStage : null
}
function stageOrder(stage: PipelineStage): number { return ["scout", "analyze", "prepare", "gate", "execute", "audit", "completed"].indexOf(stage) }
function sameJson(left: unknown, right: unknown): boolean { try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false } }

/** Persists Web's authoritative Analyze checkpoint and returns only its opaque proof. */
export async function runScheduledTaskGraphAnalyzeOnly(
  input: ScheduledTaskGraphAnalyzeOnlyInput,
): Promise<ScheduledTaskGraphAnalyzeCheckpointProof> {
  const { owner, continuationKey, claimToken } = input
  if (scheduledTaskGraphContinuationKey(owner, input.attestation) !== continuationKey
    || !await isScheduledTaskGraphOwnerCurrent(owner, continuationKey, claimToken)) {
    throw new AgentExecutionCancelledError()
  }

  const ownedJobs = input.ownedJobs.map(job => ({ ...job, coverLetter: null }))
  let checkpoint: PipelineCheckpointState
  const existing = record(input.state)
  if (existing?.scheduledTaskGraphContinuation !== undefined) {
    const prior = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot: input.snapshot,
      attestation: input.attestation, ownedJobs, existingCheckpoint: input.state })
    if (!prior.alreadyPersisted || prior.continuationKey !== continuationKey) throw new AgentExecutionCancelledError()
    checkpoint = prior.checkpoint
  } else {
    if (existing?.nextStage !== "scout") throw new AgentExecutionCancelledError()
    const analyze = await runScheduledTaskGraphAnalyze({
      jobs: ownedJobs,
      ctx: input.context,
      owner,
      key: continuationKey,
      claimToken,
      snapshot: input.snapshot,
      attestation: input.attestation,
      state: input.state,
      assertScoreOwnerCurrent: tx => scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key: continuationKey, claimToken }),
      persist: async (nextState, expectedState, tx) => {
        if (tx) {
          if (!scheduledTaskGraphClaimMatches(expectedState, continuationKey, owner, claimToken)
            || !scheduledTaskGraphClaimMatches(nextState, continuationKey, owner, claimToken)
            || !await scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key: continuationKey, claimToken })) {
            throw new AgentExecutionCancelledError()
          }
          const saved = await tx.agentExecution.updateMany({
            where: { id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId,
              status: "running", attemptCount: owner.executionAttemptCount,
              state: { equals: expectedState as Prisma.InputJsonValue } },
            data: { checkpoint: nextState.nextStage, state: nextState as unknown as Prisma.InputJsonValue },
          })
          if (saved.count !== 1) throw new AgentExecutionCancelledError()
          return
        }
        if (!await isScheduledTaskGraphOwnerCurrent(owner, continuationKey, claimToken)
          || !await saveScheduledTaskGraphCheckpoint({ expectedState, state: nextState, owner,
            key: continuationKey, claimToken,
            assertOwnerCurrent: tx => scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key: continuationKey, claimToken }) })) {
          throw new AgentExecutionCancelledError()
        }
        input.onStateChange(JSON.parse(JSON.stringify(nextState)) as PipelineCheckpointState)
      },
    })
    checkpoint = analyze.checkpoint
    if (!scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint) || checkpoint.nextStage !== "prepare"
      || !await isScheduledTaskGraphOwnerCurrent(owner, continuationKey, claimToken)) throw new AgentExecutionCancelledError()
    const saved = await saveScheduledTaskGraphCheckpoint({ expectedState: analyze.persistedState, state: checkpoint,
      owner, key: continuationKey, claimToken,
      assertOwnerCurrent: tx => scheduledTaskGraphScoreOwnerIsCurrent({ tx, owner, key: continuationKey, claimToken }) })
    if (!saved) throw new AgentExecutionCancelledError()
  }

  const checkpointDigest = scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint)
  if (!checkpointDigest || checkpoint.nextStage !== "prepare"
    || !await isScheduledTaskGraphOwnerCurrent(owner, continuationKey, claimToken)) {
    throw new AgentExecutionCancelledError()
  }
  input.onStateChange(checkpoint)
  const claimTokenDigest = `sha256:${createHash("sha256").update(claimToken, "utf8").digest("hex")}`
  return { status: "analyze_checkpointed", continuationKey, checkpointDigest, claimTokenDigest,
    executionId: owner.executionId, executionAttemptCount: owner.executionAttemptCount }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
