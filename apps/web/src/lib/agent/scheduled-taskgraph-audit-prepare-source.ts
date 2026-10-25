import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { validateScheduledTaskGraphAuditRecoveryEvidence } from './scheduled-taskgraph-audit-recovery-evidence'

const RECEIPT_EVENT = 'agent.plan.scheduled_prepare_binding'
const CANDIDATE_EVENT = 'native_verification.scheduled_candidate_staged'
const CHOICE_SCHEMA = 'agent-harness.v2.scheduled-prepare-choice-wait.v1'
const CHOICE_CONTENT = { waitKind: 'question', toolCallId: null, stage: 'scheduled_prepare',
  question: 'How should ApplyMate tailor your resume for this role?',
  options: [{ label: 'Apply AI changes', value: 'apply_ai_changes' }, { label: 'Keep my current resume', value: 'keep_resume' }] }
const MAX_ROWS = 65
type Row = Record<string, unknown>
type CandidateSource = Readonly<{ sourceEventId: string; stepId: string; ordinal: number }>

/** Validates historical Prepare choice/source identity while allowing only server-marked recovery Steps afterward. */
export async function validateScheduledTaskGraphAuditPrepareSource(input: Readonly<{
  owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; proof: unknown; scheduledWaitId?: string; reader?: Prisma.TransactionClient
}>): Promise<boolean> {
  try {
    const reader = input.reader ?? db
    const snapshot = parseScheduledAutomationSnapshot(input.snapshot), receipt = exactRecord(input.proof, ['receipt', 'completion', 'result'])?.receipt
    const parsedReceipt = parseReceipt(receipt, input.owner, scheduledAutomationSnapshotDigest(snapshot))
    if (!parsedReceipt || (snapshot.requireApproval ? !validChoiceId(input.owner.turnId, input.scheduledWaitId)
      : input.scheduledWaitId !== undefined)) return false
    const [receipts, candidates] = await Promise.all([
      reader.agentEvent.findMany({ where: { sessionId: input.owner.sessionId, turnId: input.owner.turnId, type: RECEIPT_EVENT,
        itemId: null, taskId: null, actor: 'system' }, select: { payload: true }, take: MAX_ROWS }),
      reader.agentEvent.findMany({ where: { sessionId: input.owner.sessionId, turnId: input.owner.turnId,
        taskId: input.owner.rootTaskId, type: CANDIDATE_EVENT }, orderBy: { sequence: 'desc' },
      select: { id: true, type: true, taskId: true, correlationId: true, payload: true }, take: MAX_ROWS }),
    ])
    if (receipts.length >= MAX_ROWS || candidates.length >= MAX_ROWS
      || receipts.filter(row => sameJson(row.payload, parsedReceipt)).length !== 1) return false
    const valid: CandidateSource[] = []
    for (const event of candidates) {
      const candidate = parseCandidate(event, input.owner)
      if (!candidate) continue
      const waitId = choiceId(parsedReceipt, candidate.stepId, candidate.ordinal)
      if (snapshot.requireApproval && waitId !== input.scheduledWaitId) continue
      if (await candidateSourceCurrent(reader, input.owner, parsedReceipt, candidate, waitId, snapshot.requireApproval)) valid.push(candidate)
    }
    return valid.length === 1
  } catch { return false }
}

async function candidateSourceCurrent(reader: Prisma.TransactionClient, owner: ScheduledTaskGraphPipelineOwner, receipt: Row, candidate: CandidateSource,
  waitId: string, requireChoice: boolean): Promise<boolean> {
  const source = await reader.agentStep.findFirst({ where: { id: candidate.stepId, sessionId: owner.sessionId,
    turnId: owner.turnId, taskId: owner.rootTaskId, attempt: 1, ordinal: candidate.ordinal },
  select: { id: true, ordinal: true, attempt: true, status: true, inputThroughSequence: true } })
  if (!source || !['streaming', 'waiting_for_user', 'waiting_for_tool', 'completed'].includes(source.status)
    || await rejectedStepEvent(reader, owner, source.id)) return false
  const sourceCursor = cursorValue(source.inputThroughSequence)
  if (!sourceCursor) return false
  const binding = choiceBinding(receipt, candidate.stepId, candidate.ordinal)
  const item = await reader.agentItem.findFirst({ where: { id: `agent-wait:question:${waitId}`, sessionId: owner.sessionId, turnId: owner.turnId },
    select: { id: true, stepId: true, taskId: true, type: true, status: true, content: true } })
  if (requireChoice ? !validChoiceItem(item, owner, candidate, receipt, waitId, binding) : item !== null) return false
  return validateScheduledTaskGraphAuditRecoveryEvidence({ reader, owner, source: candidate,
    sourceInputThroughSequence: sourceCursor, rootAttemptCount: owner.rootAttemptCount })
}

async function rejectedStepEvent(reader: Prisma.TransactionClient, owner: ScheduledTaskGraphPipelineOwner, stepId: string): Promise<boolean> {
  const rows = await reader.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId,
    taskId: owner.rootTaskId, correlationId: stepId, type: 'final.rejected' }, select: { id: true }, take: 1 })
  return rows.length !== 0
}
function parseReceipt(value: unknown, owner: ScheduledTaskGraphPipelineOwner, digest: string): Row | null {
  const row = exactRecord(value, ['schemaVersion', 'owner', 'continuationKey', 'snapshotDigest', 'evidenceDigest', 'checkpointDigest',
    'analyzeGraphRevision', 'prepareScheduleRevision'])
  const stable = exactRecord(row?.owner, ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId',
    'turnLeaseVersion', 'executionId', 'executionAttemptCount'])
  return row && stable && row.schemaVersion === 'agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1'
    && sameStableOwner(stable, owner) && typeof row.continuationKey === 'string' && /^scheduled-taskgraph:sha256:[a-f0-9]{64}$/.test(row.continuationKey)
    && row.snapshotDigest === digest && isHex(row.evidenceDigest) && isHex(row.checkpointDigest) && positive(row.analyzeGraphRevision)
    && positive(row.prepareScheduleRevision) && row.prepareScheduleRevision === Number(row.analyzeGraphRevision) + 1 ? row : null
}
function parseCandidate(event: Row, owner: ScheduledTaskGraphPipelineOwner): CandidateSource | null {
  const row = exactRecord(event.payload, ['schemaVersion', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'finalStepId',
    'finalStepOrdinal', 'stepAttempt', 'candidateText', 'finishReason', 'usage'])
  const usage = row?.usage === null ? null : exactRecord(row?.usage, ['inputTokens', 'outputTokens', 'estimatedCostUsd'])
  if (!row || !validId(event.id) || event.type !== CANDIDATE_EVENT || event.taskId !== owner.rootTaskId
    || row.schemaVersion !== 'agent-harness.v2.scheduled-pipeline-candidate.v2' || row.sessionId !== owner.sessionId
    || row.turnId !== owner.turnId || row.rootTaskId !== owner.rootTaskId || row.rootAttemptCount !== owner.rootAttemptCount
    || !validId(row.finalStepId) || row.finalStepId !== event.correlationId || !nonNegative(row.finalStepOrdinal) || row.stepAttempt !== 1
    || typeof row.candidateText !== 'string' || !row.candidateText.trim() || typeof row.finishReason !== 'string' || !row.finishReason.trim()
    || row.usage !== null && (!usage || !nonNegative(usage.inputTokens) || !nonNegative(usage.outputTokens)
      || typeof usage.estimatedCostUsd !== 'number' || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0)) return null
  return { sourceEventId: event.id, stepId: row.finalStepId, ordinal: Number(row.finalStepOrdinal) }
}
function validChoiceItem(item: unknown, owner: ScheduledTaskGraphPipelineOwner, candidate: CandidateSource, receipt: Row, waitId: string, binding: Row): boolean {
  const row = record(item), content = exactRecord(row?.content, ['waitKind', 'questionId', 'toolCallId', 'stage', 'question', 'options', 'answer',
    'answerAvailable', 'scheduledPrepareChoiceBinding', 'answeredAt'])
  return Boolean(row && content && row.id === `agent-wait:question:${waitId}` && row.stepId === candidate.stepId
    && row.taskId === owner.rootTaskId && row.type === 'question' && row.status === 'completed' && content.questionId === waitId
    && sameJson({ waitKind: content.waitKind, toolCallId: content.toolCallId, stage: content.stage, question: content.question, options: content.options }, CHOICE_CONTENT)
    && sameJson(content.scheduledPrepareChoiceBinding, binding) && content.answerAvailable === true
    && ['apply_ai_changes', 'keep_resume'].includes(String(content.answer)) && validIso(content.answeredAt))
}
function choiceBinding(receipt: Row, stepId: string, ordinal: number): Row {
  const owner = receipt.owner as Row
  return { schemaVersion: CHOICE_SCHEMA, owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId,
    executionAttemptCount: owner.executionAttemptCount }, continuationKey: receipt.continuationKey,
    snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest, checkpointDigest: receipt.checkpointDigest,
    analyzeGraphRevision: receipt.analyzeGraphRevision, prepareScheduleRevision: receipt.prepareScheduleRevision,
    finalStepId: stepId, finalStepOrdinal: ordinal, finalStepAttempt: 1 }
}
function choiceId(receipt: Row, stepId: string, ordinal: number): string {
  const binding = choiceBinding(receipt, stepId, ordinal), owner = binding.owner as Row
  const values = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId,
    owner.executionAttemptCount, binding.continuationKey, binding.snapshotDigest, binding.evidenceDigest, binding.checkpointDigest,
    binding.analyzeGraphRevision, binding.prepareScheduleRevision, stepId, ordinal, 1]
  return `agent-question:${String(owner.turnId)}:canonical:${createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex')}`
}
function validChoiceId(turnId: string, value: unknown): value is string {
  const prefix = `agent-question:${turnId}:canonical:`
  return typeof value === 'string' && value.startsWith(prefix) && /^[a-f0-9]{64}$/.test(value.slice(prefix.length))
}
function sameStableOwner(value: Row, owner: ScheduledTaskGraphPipelineOwner): boolean {
  return ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'executionId', 'executionAttemptCount']
    .every(key => value[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner])
}
function sameJson(left: unknown, right: unknown): boolean { try { return canonical(left) === canonical(right) } catch { return false } }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  const row = record(value), own = row && Reflect.ownKeys(row)
  return row && own?.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)) ? row : null
}
function record(value: unknown): Row | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null }
function cursorValue(value: unknown): string { const cursor = typeof value === 'bigint' || typeof value === 'number' ? String(value) : value; return validCursor(cursor) ? cursor : '' }
function validCursor(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= BigInt('9223372036854775807') }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isHex(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function validIso(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
