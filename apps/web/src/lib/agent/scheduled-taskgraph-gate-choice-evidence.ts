import { Buffer } from 'node:buffer'
import { scheduledPipelineContinuationKeyVersion } from '@jobcopilot/agent-protocol'
import type { ScheduledTaskGraphPreparedPackageRow } from './scheduled-taskgraph-gate-checkpoint'
import type { GateOutput, PipelineCheckpointState, PipelineStage } from './types'

type Row = Record<string, unknown>
export type ScheduledTaskGraphGateChoiceBinding = Readonly<{
  schemaVersion: 'agent-harness.v2.scheduled-gate-choice-wait.v1'; owner: Row; continuationKey: string
  snapshotDigest: string; evidenceDigest: string; checkpointDigest: string; analyzeGraphRevision: number; graphRevision: number
  gateTaskId: string; gateAttempt: number; kind: 'borderline_match' | 'weak_cover_letter'; jobIds: readonly string[]
  allowedChoiceIds: readonly string[]
}>
export type ScheduledTaskGraphGateDecisions = NonNullable<PipelineCheckpointState['scheduledTaskGraphGateDecisions']>

export function parseScheduledGateChoiceBinding(value: unknown): ScheduledTaskGraphGateChoiceBinding | null {
  const row = record(value), owner = record(row?.owner)
  const keys = ['schemaVersion', 'owner', 'continuationKey', 'snapshotDigest', 'evidenceDigest', 'checkpointDigest',
    'analyzeGraphRevision', 'graphRevision', 'gateTaskId', 'gateAttempt', 'kind', 'jobIds', 'allowedChoiceIds']
  const ownerKeys = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'executionId', 'executionAttemptCount']
  if (!row || !owner || !exactKeys(row, keys) || !exactKeys(owner, ownerKeys)
    || row.schemaVersion !== 'agent-harness.v2.scheduled-gate-choice-wait.v1' || !validGateOwner(owner)
    || typeof row.continuationKey !== 'string' || scheduledPipelineContinuationKeyVersion(row.continuationKey) === null
    || !/^sha256:[a-f0-9]{64}$/.test(String(row.snapshotDigest)) || !isHex(row.evidenceDigest) || !isHex(row.checkpointDigest)
    || !positive(row.analyzeGraphRevision) || !positive(row.graphRevision) || !validId(row.gateTaskId) || !positive(row.gateAttempt)
    || row.kind !== 'borderline_match' && row.kind !== 'weak_cover_letter' || !jobIds(row.jobIds, row.kind)
    || !same(row.allowedChoiceIds, choices(row.kind))) return null
  return { schemaVersion: 'agent-harness.v2.scheduled-gate-choice-wait.v1', owner: stableOwner(owner),
    continuationKey: row.continuationKey, snapshotDigest: row.snapshotDigest as string, evidenceDigest: row.evidenceDigest as string,
    checkpointDigest: row.checkpointDigest as string, analyzeGraphRevision: Number(row.analyzeGraphRevision),
    graphRevision: Number(row.graphRevision), gateTaskId: row.gateTaskId, gateAttempt: Number(row.gateAttempt), kind: row.kind,
    jobIds: [...row.jobIds as string[]].sort(), allowedChoiceIds: choices(row.kind) }
}

export function scheduledGateChoiceState(content: Row | null, status: unknown, binding: ScheduledTaskGraphGateChoiceBinding, waitId: string): boolean {
  const fields = ['waitKind', 'questionId', 'toolCallId', 'stage', 'question', 'options', 'answer', 'answerAvailable', 'scheduledGateChoiceBinding']
  const hasAck = !!content && Object.hasOwn(content, 'scheduledGateChoiceResumeAcknowledgement')
  if (!content || !exactKeys(content, status === 'completed' ? [...fields, 'answeredAt', ...(hasAck ? ['scheduledGateChoiceResumeAcknowledgement'] : [])] : fields)
    || content.waitKind !== 'question' || content.questionId !== waitId || content.toolCallId !== null || content.stage !== 'scheduled_gate'
    || typeof content.question !== 'string' || !content.question.trim() || content.question !== content.question.trim()
    || Buffer.byteLength(content.question, 'utf8') > 2_000 || !same(content.options, choiceOptions(binding.kind))
    || !same(parseScheduledGateChoiceBinding(content.scheduledGateChoiceBinding), binding)) return false
  if (hasAck && !validAck(content.scheduledGateChoiceResumeAcknowledgement, binding, waitId)) return false
  if (status === 'started') return !hasAck && content.answer === null && content.answerAvailable === false
  return status === 'completed' && validIso(content.answeredAt) && content.answerAvailable === true
    && binding.allowedChoiceIds.includes(String(content.answer))
}

export function gateDecisionsFromOutput(value: GateOutput): ScheduledTaskGraphGateDecisions | null {
  return parseGateDecisions({ approvedJobIds: value.approved.map(pkg => pkg.job.id),
    pendingJobIds: value.pending.map(pkg => pkg.job.id), skippedJobIds: value.skipped.map(pkg => pkg.job.id) })
}
export function parseGateDecisions(value: unknown): ScheduledTaskGraphGateDecisions | null {
  const row = record(value), keys = ['approvedJobIds', 'pendingJobIds', 'skippedJobIds']
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return null
  const lists = keys.map(key => row[key])
  if (lists.some(list => !Array.isArray(list) || !list.every(id => typeof id === 'string' && id.length > 0 && id.trim() === id)
    || new Set(list as string[]).size !== (list as string[]).length)) return null
  return { approvedJobIds: [...lists[0] as string[]], pendingJobIds: [...lists[1] as string[]], skippedJobIds: [...lists[2] as string[]] }
}
export function restoreGateOutput(decisions: ScheduledTaskGraphGateDecisions,
  packages: readonly ScheduledTaskGraphPreparedPackageRow[]): GateOutput | null {
  const byId = new Map(packages.map(row => [row.jobId, row.package]))
  const ids = [...decisions.approvedJobIds, ...decisions.pendingJobIds, ...decisions.skippedJobIds]
  if (ids.length !== byId.size || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) return null
  return { approved: decisions.approvedJobIds.map(id => byId.get(id)!), pending: decisions.pendingJobIds.map(id => byId.get(id)!),
    skipped: decisions.skippedJobIds.map(id => byId.get(id)!) }
}
export function scheduledTaskGraphPipelineStage(value: unknown): PipelineStage | null {
  return typeof value === 'string' && ['scout', 'analyze', 'prepare', 'gate', 'execute', 'audit', 'completed'].includes(value)
    ? value as PipelineStage : null
}
export function scheduledTaskGraphPipelineStageOrder(stage: PipelineStage): number {
  return ['scout', 'analyze', 'prepare', 'gate', 'execute', 'audit', 'completed'].indexOf(stage)
}

function validAck(value: unknown, binding: ScheduledTaskGraphGateChoiceBinding, waitId: string): boolean {
  const row = record(value), itemId = `agent-wait:question:${waitId}`
  return !!row && exactKeys(row, ['gateTaskId', 'requestAttemptCount', 'waitId', 'itemId', 'resumedAttemptCount'])
    && row.gateTaskId === binding.gateTaskId && row.requestAttemptCount === binding.gateAttempt && row.waitId === waitId
    && row.itemId === itemId && row.resumedAttemptCount === binding.gateAttempt + 1
}
function jobIds(value: unknown, kind: string): value is string[] { return Array.isArray(value) && value.length >= 1 && value.length <= 50
  && (kind !== 'weak_cover_letter' || value.length === 1) && value.every(validId) && new Set(value).size === value.length }
function choices(kind: string): readonly string[] { return kind === 'weak_cover_letter' ? ['continue', 'review', 'skip'] : ['add_to_pending', 'skip', 'lower_threshold'] }
function choiceOptions(kind: string): readonly Row[] { return kind === 'weak_cover_letter'
  ? [{ label: 'Continue with current materials', value: 'continue' }, { label: 'Place for review', value: 'review' }, { label: 'Skip', value: 'skip' }]
  : [{ label: 'Include for review', value: 'add_to_pending' }, { label: 'Skip', value: 'skip' }, { label: 'Lower threshold 5%', value: 'lower_threshold' }] }
function validGateOwner(value: Row): boolean { return [value.userId, value.sessionId, value.turnId, value.rootTaskId].every(validId)
  && positive(value.rootAttemptCount) && validId(value.executionId) && nonNegative(value.executionAttemptCount) }
function stableOwner(value: Row): Row { return { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: value.rootTaskId,
  ...(value.rootAttemptCount !== undefined ? { rootAttemptCount: value.rootAttemptCount } : {}), ...(value.executionId !== undefined ? { executionId: value.executionId } : {}),
  ...(value.executionAttemptCount !== undefined ? { executionAttemptCount: value.executionAttemptCount } : {}) } }
function record(value: unknown): Row | null {
  if (typeof value === 'string') { try { value = JSON.parse(value) as unknown } catch { return null } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Row : null
  } catch { return null }
}
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(',') }
function validId(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isHex(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function validIso(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => same(value, right[index]))
  const a = record(left), b = record(right)
  if (!a || !b) return false
  const keys = Object.keys(a).sort(), otherKeys = Object.keys(b).sort()
  return keys.length === otherKeys.length && keys.every((key, index) => key === otherKeys[index] && same(a[key], b[key]))
}
