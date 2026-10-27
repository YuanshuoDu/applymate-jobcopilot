import { createHash } from 'node:crypto'
import { Prisma, type Job } from "@prisma/client"
import { db } from "@/lib/db"
import { AgentExecutionCancelledError } from "./execution-control"
import { runScheduledTaskGraphAnalyze, scheduledTaskGraphScoreOwnerIsCurrent } from "./scheduled-taskgraph-analysis-journal"
import { buildScheduledTaskGraphGateCheckpoint, scheduledTaskGraphAnalyzeCheckpointDigest } from "./scheduled-taskgraph-gate-checkpoint"
import { scheduledTaskGraphAnalyzeCheckpointForGate } from "./scheduled-taskgraph-gate-input"
import { buildScheduledTaskGraphPrepareCheckpoint, scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import { isScheduledTaskGraphOwnerCurrent, saveScheduledTaskGraphCheckpoint, scheduledTaskGraphClaimMatches } from "./scheduled-taskgraph-pipeline-fence"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import { scheduledTaskGraphExecuteGateCompletionProof } from "./scheduled-taskgraph-gate-rpc"
import { loadScheduledTaskGraphResumeGateInput, scheduledTaskGraphGateResumeOwnerIsCurrent,
  validateScheduledTaskGraphAuditPrepareSource, type ScheduledTaskGraphGateResumeInput } from "./scheduled-taskgraph-audit-action"
import { isScheduledPrepareChoiceWaitId, parseScheduledPrepareChoiceCandidate, parseScheduledPrepareChoiceReceipt,
  scheduledPrepareChoiceBinding, scheduledPrepareChoiceId } from "./scheduled-taskgraph-run-receipt"
import { gateDecisionsFromOutput, parseGateDecisions, restoreGateOutput, scheduledTaskGraphPipelineStage as pipelineStage,
  scheduledTaskGraphPipelineStageOrder as stageOrder, type ScheduledTaskGraphGateDecisions } from "./scheduled-taskgraph-gate-choice-evidence"
import type { PipelineCtx } from "./pipeline-context"
import type { PipelineCheckpointState } from "./types"

export type ScheduledTaskGraphAnalyzeCheckpointProof = Readonly<{ status: "analyze_checkpointed"; continuationKey: string; checkpointDigest: string; claimTokenDigest: string; executionId: string; executionAttemptCount: number }>
export type ScheduledTaskGraphAnalyzeOnlyInput = Readonly<{ owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; attestation: unknown; continuationKey: string; claimToken: string; ownedJobs: readonly Job[]; context: PipelineCtx; state: unknown; onStateChange: (state: unknown) => void }>

const RECEIPT_EVENT = "agent.plan.scheduled_prepare_binding"
const CANDIDATE_EVENT = "native_verification.scheduled_candidate_staged"
const CHOICE_CONTENT = { waitKind: "question", toolCallId: null, stage: "scheduled_prepare",
  question: "How should ApplyMate tailor your resume for this role?",
  options: [{ label: "Apply AI changes", value: "apply_ai_changes" }, { label: "Keep my current resume", value: "keep_resume" }] }
export { isScheduledPrepareChoiceWaitId } from "./scheduled-taskgraph-run-receipt"
/** Validates the separate Worker choice wait against its private receipt and persisted final step. */
export async function validateScheduledPrepareWaitIdentity(input: Readonly<{ owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; proof: unknown; scheduledWaitId?: string }>): Promise<boolean> {
  let snapshot: ReturnType<typeof parseScheduledAutomationSnapshot>
  try { snapshot = parseScheduledAutomationSnapshot(input.snapshot) } catch { return false }
  const proof = exactRecord(input.proof, ["receipt", "completion", "result"]), receipt = parseScheduledPrepareChoiceReceipt(proof?.receipt, input.owner)
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
    const candidate = parseScheduledPrepareChoiceCandidate(row.payload, row.type, row.taskId, row.correlationId, input.owner)
    return candidate && (snapshot.requireApproval ? scheduledPrepareChoiceId(receipt, candidate.finalStepId, candidate.finalStepOrdinal) === input.scheduledWaitId
      : candidate.finalStepId === latest?.id) ? [candidate] : []
  })
  if (matching.length !== 1 || !latest) return false
  const candidate = matching[0]!, waitId = scheduledPrepareChoiceId(receipt, candidate.finalStepId, candidate.finalStepOrdinal)
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
  const content = exactRecord(item.content, ["waitKind", "questionId", "toolCallId", "stage", "question", "options", "answer", "answerAvailable", "scheduledPrepareChoiceBinding", "answeredAt"])
  const binding = scheduledPrepareChoiceBinding(receipt, candidate.finalStepId, candidate.finalStepOrdinal)
  return Boolean(item.id === itemId && item.stepId === candidate.finalStepId && item.taskId === input.owner.rootTaskId && item.type === "question"
    && content && content.questionId === input.scheduledWaitId
    && sameCanonicalJson({ waitKind: content.waitKind, toolCallId: content.toolCallId, stage: content.stage, question: content.question, options: content.options }, CHOICE_CONTENT)
    && sameCanonicalJson(content.scheduledPrepareChoiceBinding, binding)
    && item.status === "completed" && validIso(content.answeredAt) && content.answerAvailable === true
    && ["apply_ai_changes", "keep_resume"].includes(String(content.answer)))
}
/** Rebuilds a private Gate/Execute state from a verified Worker proof and owner-scoped artifact rows. */
export async function buildScheduledTaskGraphGateResumeState(input: ScheduledTaskGraphGateResumeInput): Promise<PipelineCheckpointState> {
  const { owner, continuationKey, claimToken } = input
  const ownerIsCurrent = () => scheduledTaskGraphGateResumeOwnerIsCurrent(input)
  const persisted = record(input.persistedCheckpoint), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
  const analyzeCheckpoint = scheduledTaskGraphAnalyzeCheckpointForGate(input.persistedCheckpoint)
  const persistedWaitId = persisted?.scheduledTaskGraphScheduledWaitId
  if (!analyzeCheckpoint || scheduledTaskGraphContinuationKey(owner, input.attestation) !== continuationKey
    || (snapshot.requireApproval ? persistedWaitId !== undefined && persistedWaitId !== input.scheduledWaitId : persistedWaitId !== undefined || input.scheduledWaitId !== undefined)
    || !await ownerIsCurrent()) throw new AgentExecutionCancelledError()
  const prepareIsCurrent = input.auditActor
    ? await validateScheduledTaskGraphAuditPrepareSource({ owner, snapshot, proof: input.prepareProof, scheduledWaitId: input.scheduledWaitId })
    : await validateScheduledPrepareWaitIdentity({ owner, snapshot, proof: input.prepareProof, scheduledWaitId: input.scheduledWaitId })
  if (!prepareIsCurrent) throw new AgentExecutionCancelledError()
  const storedStage = pipelineStage(persisted?.nextStage), completion = scheduledTaskGraphExecuteGateCompletionProof(input.gateCompletionProof)
  const completionGate = completion?.gate as { taskId: string; attemptCount: number } | undefined
  if (!storedStage || input.gateCompletionProof !== undefined && (!completion || !sameCanonicalJson(completion.prepareProof, input.prepareProof))) throw new AgentExecutionCancelledError()
  const requestedStage = completion && storedStage === 'gate' ? 'execute' : storedStage
  if ((storedStage === 'execute' || storedStage === 'audit') && !completion || input.gateCompletionProof !== undefined && requestedStage === 'prepare') throw new AgentExecutionCancelledError()
  const loaded = await loadScheduledTaskGraphResumeGateInput(input, analyzeCheckpoint, completionGate)
  if (!loaded) throw new AgentExecutionCancelledError()
  const handoff = buildScheduledTaskGraphGateCheckpoint({
    analyze: { owner, snapshot: input.snapshot, attestation: input.attestation, ownedJobs: input.ownedJobs, persistedCheckpoint: analyzeCheckpoint, activeClaimToken: claimToken },
    proof: input.prepareProof, packages: loaded.packages, materials: loaded.materials })
  if (!handoff || !await ownerIsCurrent()) throw new AgentExecutionCancelledError()
  if (!persisted) throw new AgentExecutionCancelledError()
  const artifactRefs = loaded.materials.map(({ jobId, kind, artifactRef }) => ({ jobId, kind, artifactRef }))
  if (persisted?.scheduledTaskGraphPreparedArtifacts !== undefined
    && !sameCanonicalJson(persisted.scheduledTaskGraphPreparedArtifacts, artifactRefs)) throw new AgentExecutionCancelledError()
  if (!["prepare", "gate", "execute", "audit"].includes(requestedStage)) throw new AgentExecutionCancelledError()
  const decisions = loaded.gateResult?.status === 'completed' ? parseGateDecisions({
    approvedJobIds: loaded.gateResult.approvedJobIds, pendingJobIds: loaded.gateResult.pendingJobIds, skippedJobIds: loaded.gateResult.skippedJobIds })
    : parseGateDecisions(persisted?.scheduledTaskGraphGateDecisions)
  if (loaded.gateResult && persisted?.scheduledTaskGraphGateDecisions !== undefined
    && !sameCanonicalJson(persisted.scheduledTaskGraphGateDecisions, decisions)) throw new AgentExecutionCancelledError()
  const gateOutput = decisions ? restoreGateOutput(decisions, loaded.packages) : undefined
  if (completion && loaded.gateResult?.status !== 'completed') throw new AgentExecutionCancelledError()
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
      if (!decisions || (state.scheduledTaskGraphGateDecisions && !sameCanonicalJson(state.scheduledTaskGraphGateDecisions, decisions))) return null
      state.scheduledTaskGraphGateDecisions = decisions
    }
    delete state.gateOutput
    return state
  } catch { return null }
}


/** Persists Web's authoritative Analyze checkpoint and returns only its opaque proof. */
export async function runScheduledTaskGraphAnalyzeOnly(input: ScheduledTaskGraphAnalyzeOnlyInput): Promise<ScheduledTaskGraphAnalyzeCheckpointProof> {
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
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value)
  return row && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === 'string' && keys.includes(key)) ? row : null
}
function validIso(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function sameCanonicalJson(left: unknown, right: unknown): boolean { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('invalid_gate_completion_json')
  return encoded
}
