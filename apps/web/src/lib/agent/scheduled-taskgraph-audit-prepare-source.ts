import { Prisma } from '@prisma/client'
import { parseScheduledPipelineCandidatePayload } from '@jobcopilot/agent-protocol'
import { db } from '@/lib/db'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { validateScheduledTaskGraphAuditRecoveryEvidence } from './scheduled-taskgraph-audit-recovery-evidence'
import { isScheduledPrepareChoiceWaitId, parseScheduledPrepareChoiceReceipt, scheduledPrepareChoiceBinding, scheduledPrepareChoiceId } from './scheduled-taskgraph-run-receipt'

const RECEIPT_EVENT = 'agent.plan.scheduled_prepare_binding'
const CANDIDATE_EVENT = 'native_verification.scheduled_candidate_staged'
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
    const parsedReceipt = parseScheduledPrepareChoiceReceipt(receipt, input.owner, scheduledAutomationSnapshotDigest(snapshot))
    if (!parsedReceipt || (snapshot.requireApproval ? !isScheduledPrepareChoiceWaitId(input.owner.turnId, input.scheduledWaitId)
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
      const waitId = scheduledPrepareChoiceId(parsedReceipt, candidate.stepId, candidate.ordinal)
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
  const binding = scheduledPrepareChoiceBinding(receipt, candidate.stepId, candidate.ordinal)
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
function parseCandidate(event: Row, owner: ScheduledTaskGraphPipelineOwner): CandidateSource | null {
  const row = parseScheduledPipelineCandidatePayload(event.payload)
  if (!row || !validId(event.id) || event.type !== CANDIDATE_EVENT || event.taskId !== owner.rootTaskId
    || row.sessionId !== owner.sessionId || row.turnId !== owner.turnId || row.rootTaskId !== owner.rootTaskId
    || row.rootAttemptCount !== owner.rootAttemptCount || row.sourceReceipt !== null && row.sourceReceipt.scope.userId !== owner.userId
    || !validId(row.finalStepId) || row.finalStepId !== event.correlationId) return null
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
function validIso(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
