import { createHash } from "node:crypto"
import { parseScheduledPipelineCandidatePayload } from "@jobcopilot/agent-protocol"
import { db } from "@/lib/db"
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"

const CHOICE_SCHEMA = "agent-harness.v2.scheduled-prepare-choice-wait.v1"
const RECEIPT_EVENT = "agent.plan.scheduled_prepare_binding"
const CANDIDATE_EVENT = "native_verification.scheduled_candidate_staged"
const CHOICE_CONTENT = { waitKind: "question", toolCallId: null, stage: "scheduled_prepare",
  question: "How should ApplyMate tailor your resume for this role?",
  options: [{ label: "Apply AI changes", value: "apply_ai_changes" }, { label: "Keep my current resume", value: "keep_resume" }] }

export function isScheduledPrepareChoiceWaitId(turnId: string, value: unknown): value is string {
  const prefix = `agent-question:${turnId}:canonical:`
  return typeof value === "string" && value.startsWith(prefix) && /^[a-f0-9]{64}$/.test(value.slice(prefix.length))
}

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
  const content = exactRecord(item.content, ["waitKind", "questionId", "toolCallId", "stage", "question", "options", "answer", "answerAvailable", "scheduledPrepareChoiceBinding", "answeredAt"])
  const binding = choiceBinding(receipt, candidate.finalStepId, candidate.finalStepOrdinal)
  return Boolean(item.id === itemId && item.stepId === candidate.finalStepId && item.taskId === input.owner.rootTaskId && item.type === "question"
    && content && content.questionId === input.scheduledWaitId
    && sameCanonicalJson({ waitKind: content.waitKind, toolCallId: content.toolCallId, stage: content.stage, question: content.question, options: content.options }, CHOICE_CONTENT)
    && sameCanonicalJson(content.scheduledPrepareChoiceBinding, binding)
    && item.status === "completed" && validIso(content.answeredAt) && content.answerAvailable === true
    && ["apply_ai_changes", "keep_resume"].includes(String(content.answer)))
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
  const row = parseScheduledPipelineCandidatePayload(value)
  if (!row || type !== CANDIDATE_EVENT || taskId !== owner.rootTaskId
    || row.sessionId !== owner.sessionId || row.turnId !== owner.turnId || row.rootTaskId !== owner.rootTaskId
    || row.rootAttemptCount !== owner.rootAttemptCount || row.sourceReceipt !== null && row.sourceReceipt.scope.userId !== owner.userId
    || !validId(row.finalStepId) || row.finalStepId !== correlationId) return null
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

function sameStableOwner(a: Record<string, unknown>, b: ScheduledTaskGraphPipelineOwner): boolean {
  return ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
    .every(key => a[key] === b[key as keyof ScheduledTaskGraphPipelineOwner])
}
function isHex(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function validIso(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value)
  return row && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key)) ? row : null
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function sameCanonicalJson(left: unknown, right: unknown): boolean { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('invalid_gate_completion_json')
  return encoded
}
