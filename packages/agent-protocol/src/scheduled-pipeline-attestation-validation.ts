import {
  type ScheduledPipelineAnalystAttestationV1,
  type ScheduledPipelineAnalystProofV2,
  type ScheduledPipelineAttestation,
  type ScheduledPipelineAttestationOwner,
  type ScheduledPipelineAttestationV1,
  type ScheduledPipelineAttestationV2,
  type ScheduledPipelineDiscoveryReceipt,
  type ScheduledPipelineScoutAttestationV1,
  type ScheduledPipelineScoutProofV2,
} from './scheduled-pipeline-attestation.js'

type Row = Record<string, unknown>
const HEX = /^[a-f0-9]{64}$/
const SNAPSHOT = /^sha256:[a-f0-9]{64}$/
const V1_SCHEMA = 'agent-harness.v2.scheduled-pipeline-attestation.v1' as const
const V2_SCHEMA = 'agent-harness.v2.scheduled-pipeline-attestation.v2' as const
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion']
const RECEIPT_KEYS = ['status', 'taskId', 'attemptCount', 'completedCalls', 'candidateCount', 'providerFailures', 'materializationFailures', 'hasMore', 'receiptDigest']

export function parseScheduledPipelineAttestationValue(value: unknown): ScheduledPipelineAttestation | null {
  try {
    const row = exactRecord(value, ['schemaVersion', 'owner', 'snapshotDigest', 'graphRevision', 'scout', 'analyst', 'evidenceDigest'])
      ?? exactRecord(value, ['schemaVersion', 'owner', 'snapshotDigest', 'graphRevision', 'scouts', 'candidateUnionJobIds', 'analyst', 'evidenceDigest'])
    if (!row) return null
    return row.schemaVersion === V1_SCHEMA ? parseV1(row) : row.schemaVersion === V2_SCHEMA ? parseV2(row) : null
  } catch { return null }
}

function parseV1(row: Row): ScheduledPipelineAttestationV1 | null {
  const owner = parseOwner(row.owner)
  const scoutRow = exactRecord(row.scout, ['taskId', 'attemptCount', 'status', 'verification', 'resultDigest', 'candidateJobIds', 'discoveryReceipt'])
  const analystRow = exactRecord(row.analyst, ['taskId', 'attemptCount', 'status', 'verification', 'resultDigest', 'dependsOnTaskIds', 'jobIds'])
  const scout = scoutRow && parseScoutV1(scoutRow), analyst = analystRow && parseAnalystV1(analystRow)
  if (!owner || !scout || !analyst || !snapshotDigest(row.snapshotDigest) || !positive(row.graphRevision) || !digest(row.evidenceDigest)
    || analyst.dependsOnTaskIds.length !== 1 || analyst.dependsOnTaskIds[0] !== scout.taskId
    || analyst.jobIds.some(id => !scout.candidateJobIds.includes(id))) return null
  return { schemaVersion: V1_SCHEMA, owner, snapshotDigest: row.snapshotDigest as string,
    graphRevision: row.graphRevision as number, scout, analyst, evidenceDigest: row.evidenceDigest as string }
}

function parseV2(row: Row): ScheduledPipelineAttestationV2 | null {
  const owner = parseOwner(row.owner), scouts = dataArray(row.scouts, 4), union = ids(row.candidateUnionJobIds, 200, true)
  const analystRow = exactRecord(row.analyst, ['nodeKey', 'taskId', 'attemptCount', 'status', 'verification', 'resultDigest', 'nodeDigest', 'evidenceDigest', 'reportDigest', 'dependsOnTaskIds', 'jobIds'])
  const analyst = analystRow && parseAnalystV2(analystRow)
  if (!owner || !scouts || scouts.length < 2 || !union || !analyst || !snapshotDigest(row.snapshotDigest)
    || !positive(row.graphRevision) || !digest(row.evidenceDigest)) return null
  const parsedScouts = scouts.map(item => { const value = exactRecord(item, ['nodeKey', 'taskId', 'attemptCount', 'status', 'verification', 'resultDigest', 'nodeDigest', 'evidenceDigest', 'reportDigest', 'candidateJobIds', 'discoveryReceipt']); return value && parseScoutV2(value) })
  if (parsedScouts.some(value => !value)) return null
  const sources = parsedScouts as ScheduledPipelineScoutProofV2[]
  const keys = sources.map(value => value.nodeKey), taskIds = sources.map(value => value.taskId)
  if (!strictlySorted(keys) || !unique(taskIds) || keys.includes(analyst.nodeKey) || taskIds.includes(analyst.taskId)) return null
  const completeUnion = [...new Set(sources.flatMap(value => value.candidateJobIds))].sort()
  if (!union.length || !analyst.jobIds.length || !sameStrings(union, completeUnion)
    || analyst.dependsOnTaskIds.length !== taskIds.length || !sameStrings(analyst.dependsOnTaskIds, [...taskIds].sort())
    || analyst.jobIds.some(id => !union.includes(id))) return null
  return { schemaVersion: V2_SCHEMA, owner, snapshotDigest: row.snapshotDigest as string,
    graphRevision: row.graphRevision as number, scouts: sources, candidateUnionJobIds: union, analyst, evidenceDigest: row.evidenceDigest as string }
}

function parseScoutV1(row: Row): ScheduledPipelineScoutAttestationV1 | null {
  const candidateJobIds = ids(row.candidateJobIds, Number.MAX_SAFE_INTEGER, false), receipt = parseReceipt(row.discoveryReceipt, false)
  return validTaskProof(row) && candidateJobIds && receipt
    ? { taskId: row.taskId as string, attemptCount: row.attemptCount as number, status: 'completed', verification: 'passed', resultDigest: row.resultDigest as string, candidateJobIds, discoveryReceipt: receipt }
    : null
}

function parseAnalystV1(row: Row): ScheduledPipelineAnalystAttestationV1 | null {
  const dependsOnTaskIds = ids(row.dependsOnTaskIds, Number.MAX_SAFE_INTEGER, false), jobIds = ids(row.jobIds, Number.MAX_SAFE_INTEGER, false)
  return validTaskProof(row) && dependsOnTaskIds && jobIds
    ? { taskId: row.taskId as string, attemptCount: row.attemptCount as number, status: 'completed', verification: 'passed', resultDigest: row.resultDigest as string, dependsOnTaskIds, jobIds }
    : null
}

function parseScoutV2(row: Row): ScheduledPipelineScoutProofV2 | null {
  const candidateJobIds = ids(row.candidateJobIds, 50, false), receipt = parseReceipt(row.discoveryReceipt, true)
  if (!validTaskProof(row) || !validId(row.nodeKey) || !digest(row.nodeDigest) || !digest(row.evidenceDigest) || !digest(row.reportDigest)
    || !candidateJobIds || !receipt || receipt.taskId !== row.taskId || receipt.attemptCount !== row.attemptCount
    || receipt.completedCalls < 1 || receipt.candidateCount !== candidateJobIds.length || receipt.providerFailures !== 0
    || receipt.materializationFailures !== 0 || receipt.hasMore) return null
  return { nodeKey: row.nodeKey, taskId: row.taskId as string, attemptCount: row.attemptCount as number, status: 'completed', verification: 'passed',
    resultDigest: row.resultDigest as string, nodeDigest: row.nodeDigest as string, evidenceDigest: row.evidenceDigest as string,
    reportDigest: row.reportDigest as string, candidateJobIds, discoveryReceipt: receipt }
}

function parseAnalystV2(row: Row): ScheduledPipelineAnalystProofV2 | null {
  const dependsOnTaskIds = ids(row.dependsOnTaskIds, 4, true), jobIds = ids(row.jobIds, 50, false)
  return validTaskProof(row) && validId(row.nodeKey) && digest(row.nodeDigest) && digest(row.evidenceDigest) && digest(row.reportDigest)
    && dependsOnTaskIds && jobIds ? { nodeKey: row.nodeKey, taskId: row.taskId as string, attemptCount: row.attemptCount as number,
      status: 'completed', verification: 'passed', resultDigest: row.resultDigest as string, nodeDigest: row.nodeDigest as string,
      evidenceDigest: row.evidenceDigest as string, reportDigest: row.reportDigest as string, dependsOnTaskIds, jobIds } : null
}

function parseReceipt(value: unknown, complete: boolean): ScheduledPipelineDiscoveryReceipt | null {
  const row = exactRecord(value, RECEIPT_KEYS)
  if (!row || row.status !== 'complete' || !validId(row.taskId) || !positive(row.attemptCount) || !count(row.completedCalls)
    || !count(row.candidateCount) || !count(row.providerFailures) || !count(row.materializationFailures)
    || typeof row.hasMore !== 'boolean' || !digest(row.receiptDigest)) return null
  if (complete && (!row.completedCalls || row.providerFailures !== 0 || row.materializationFailures !== 0 || row.hasMore)) return null
  return { status: 'complete', taskId: row.taskId, attemptCount: row.attemptCount as number, completedCalls: row.completedCalls as number,
    candidateCount: row.candidateCount as number, providerFailures: row.providerFailures as number,
    materializationFailures: row.materializationFailures as number, hasMore: row.hasMore, receiptDigest: row.receiptDigest as string }
}

function validTaskProof(row: Row): boolean {
  return validId(row.taskId) && positive(row.attemptCount) && row.status === 'completed' && row.verification === 'passed' && digest(row.resultDigest)
}
function parseOwner(value: unknown): ScheduledPipelineAttestationOwner | null {
  const row = exactRecord(value, OWNER_KEYS)
  if (!row || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId].every(validId)
    || !positive(row.rootAttemptCount) || !positive(row.turnLeaseVersion)) return null
  return { userId: row.userId as string, sessionId: row.sessionId as string, turnId: row.turnId as string, rootTaskId: row.rootTaskId as string,
    rootAttemptCount: row.rootAttemptCount as number, turnLeaseOwnerId: row.turnLeaseOwnerId as string, turnLeaseVersion: row.turnLeaseVersion as number }
}

function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
  if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
    || !ownKeys.every(key => typeof key === 'string' && keys.includes(key))) return null
  const result: Row = Object.create(null) as Row
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null; result[key] = descriptor.value }
  return result
}

function dataArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || lengthDescriptor.enumerable || !Object.hasOwn(lengthDescriptor, 'value')) return null
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || Number(length) > max) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== Number(length) + 1 || !keys.includes('length')) return null
  const result: unknown[] = []
  for (let i = 0; i < Number(length); i++) {
    if (!keys.includes(String(i))) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    result.push(descriptor.value)
  }
  return result
}

function ids(value: unknown, max: number, sorted: boolean): string[] | null {
  const values = dataArray(value, max)
  if (!values || values.some(item => !validId(item))) return null
  const result = values as string[]
  return unique(result) && (!sorted || strictlySorted(result)) ? result : null
}
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length }
function strictlySorted(values: readonly string[]): boolean { return values.every((value, i) => i === 0 || values[i - 1]! < value) }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, i) => value === right[i]) }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function digest(value: unknown): value is string { return typeof value === 'string' && HEX.test(value) }
function snapshotDigest(value: unknown): value is string { return typeof value === 'string' && SNAPSHOT.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
