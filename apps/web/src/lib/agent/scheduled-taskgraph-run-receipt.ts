import { createHash } from 'node:crypto'
import { scheduledPipelineContinuationKeyVersion } from '@jobcopilot/agent-protocol'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

type Row = Record<string, unknown>
const RECEIPT_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1'
const RECEIPT_KEYS = ['schemaVersion', 'owner', 'continuationKey', 'snapshotDigest', 'evidenceDigest', 'checkpointDigest',
  'analyzeGraphRevision', 'prepareScheduleRevision']
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount']
const CHOICE_SCHEMA = 'agent-harness.v2.scheduled-prepare-choice-wait.v1'

export function isScheduledPrepareChoiceWaitId(turnId: string, value: unknown): value is string {
  const prefix = `agent-question:${turnId}:canonical:`
  return typeof value === 'string' && value.startsWith(prefix) && /^[a-f0-9]{64}$/.test(value.slice(prefix.length))
}

export function parseScheduledPrepareChoiceReceipt(value: unknown, expected: ScheduledTaskGraphPipelineOwner, digest?: string): Row | null {
  const row = exactRecord(value, RECEIPT_KEYS), owner = exactRecord(row?.owner, OWNER_KEYS)
  if (!row || !owner || row.schemaVersion !== RECEIPT_SCHEMA || !sameStableOwner(owner, expected)
    || typeof row.continuationKey !== 'string' || scheduledPipelineContinuationKeyVersion(row.continuationKey) === null
    || typeof row.snapshotDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.snapshotDigest)
    || digest !== undefined && row.snapshotDigest !== digest || !isHex(row.evidenceDigest) || !isHex(row.checkpointDigest)
    || !positive(row.analyzeGraphRevision) || !positive(row.prepareScheduleRevision)
    || row.prepareScheduleRevision !== Number(row.analyzeGraphRevision) + 1) return null
  return row
}

export function parseScheduledPrepareChoiceCandidate(value: unknown, type: unknown, taskId: unknown,
  correlationId: unknown, owner: ScheduledTaskGraphPipelineOwner): Readonly<{ finalStepId: string; finalStepOrdinal: number }> | null {
  const row = exactRecord(value, ['schemaVersion', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'finalStepId',
    'finalStepOrdinal', 'stepAttempt', 'candidateText', 'finishReason', 'usage'])
  const usage = row?.usage === null ? null : exactRecord(row?.usage, ['inputTokens', 'outputTokens', 'estimatedCostUsd'])
  if (!row || type !== 'native_verification.scheduled_candidate_staged' || taskId !== owner.rootTaskId
    || row.schemaVersion !== 'agent-harness.v2.scheduled-pipeline-candidate.v2' || row.sessionId !== owner.sessionId
    || row.turnId !== owner.turnId || row.rootTaskId !== owner.rootTaskId || row.rootAttemptCount !== owner.rootAttemptCount
    || !validId(row.finalStepId) || row.finalStepId !== correlationId || !nonNegative(row.finalStepOrdinal) || row.stepAttempt !== 1
    || typeof row.candidateText !== 'string' || !row.candidateText.trim() || typeof row.finishReason !== 'string' || !row.finishReason.trim()
    || row.usage !== null && (!usage || !nonNegative(usage.inputTokens) || !nonNegative(usage.outputTokens)
      || typeof usage.estimatedCostUsd !== 'number' || !Number.isFinite(usage.estimatedCostUsd) || usage.estimatedCostUsd < 0)) return null
  return { finalStepId: row.finalStepId, finalStepOrdinal: Number(row.finalStepOrdinal) }
}

export function scheduledPrepareChoiceBinding(receipt: Row, stepId: string, ordinal: number): Row {
  const owner = receipt.owner as Row
  return { schemaVersion: CHOICE_SCHEMA, owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount, executionId: owner.executionId,
    executionAttemptCount: owner.executionAttemptCount }, continuationKey: receipt.continuationKey,
    snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest, checkpointDigest: receipt.checkpointDigest,
    analyzeGraphRevision: receipt.analyzeGraphRevision, prepareScheduleRevision: receipt.prepareScheduleRevision,
    finalStepId: stepId, finalStepOrdinal: ordinal, finalStepAttempt: 1 }
}

export function scheduledPrepareChoiceId(receipt: Row, stepId: string, ordinal: number): string {
  const binding = scheduledPrepareChoiceBinding(receipt, stepId, ordinal), owner = binding.owner as Row
  const projection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId,
    owner.executionAttemptCount, binding.continuationKey, binding.snapshotDigest, binding.evidenceDigest, binding.checkpointDigest,
    binding.analyzeGraphRevision, binding.prepareScheduleRevision, stepId, ordinal, 1]
  return `agent-question:${String(owner.turnId)}:canonical:${createHash('sha256').update(JSON.stringify(projection), 'utf8').digest('hex')}`
}

function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  const row = record(value), own = row && Reflect.ownKeys(row)
  return row && own?.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)) ? row : null
}
function record(value: unknown): Row | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isHex(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function sameStableOwner(value: Row, owner: ScheduledTaskGraphPipelineOwner): boolean {
  return ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'executionId', 'executionAttemptCount']
    .every(key => value[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner])
}
