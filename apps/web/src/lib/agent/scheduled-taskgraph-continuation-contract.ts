import { scheduledPipelineContinuationKeyVersion } from '@jobcopilot/agent-protocol'
import type { PipelineCtx } from './pipeline-context'

const CONTINUATION_SCHEMA = 'agent-harness.v2.scheduled-pipeline-continuation.v1'
const CLAIM_SCHEMA = 'agent-harness.v2.scheduled-pipeline-claim.v1'
const SNAPSHOT_DIGEST = /^sha256:[a-f0-9]{64}$/
const HEX_DIGEST = /^[a-f0-9]{64}$/
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount']
const CONTINUATION_KEYS = ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest']
const CLAIM_KEYS = ['schemaVersion', 'key', 'claimToken', 'owner', 'claimedAt', 'leaseExpiresAt']

export function isScheduledTaskGraphContinuationKey(value: unknown): value is string {
  return scheduledPipelineContinuationKeyVersion(value) !== null
}

export function allowVerifiedEmptyScheduledTaskGraphContinuation(stateValue: unknown, ctx: PipelineCtx): boolean {
  const state = record(stateValue), marker = record(state?.scheduledTaskGraphContinuation), claim = record(state?.scheduledTaskGraphClaim)
  const markerOwner = record(marker?.owner), claimOwner = record(claim?.owner)
  if (!state || !marker || !claim || !markerOwner || !claimOwner
    || !hasExactKeys(marker, CONTINUATION_KEYS) || !hasExactKeys(claim, CLAIM_KEYS)
    || !continuationOwner(markerOwner, ctx) || !continuationOwner(claimOwner, ctx) || !sameContinuationOwner(markerOwner, claimOwner)
    || marker.schemaVersion !== CONTINUATION_SCHEMA || claim.schemaVersion !== CLAIM_SCHEMA
    || typeof marker.key !== 'string' || !isScheduledTaskGraphContinuationKey(marker.key) || claim.key !== marker.key
    || !validId(claim.claimToken) || !validTimestamp(claim.claimedAt) || !validTimestamp(claim.leaseExpiresAt)
    || Date.parse(claim.leaseExpiresAt) <= Date.parse(claim.claimedAt)
    || typeof marker.snapshotDigest !== 'string' || !SNAPSHOT_DIGEST.test(marker.snapshotDigest)
    || typeof marker.evidenceDigest !== 'string' || !HEX_DIGEST.test(marker.evidenceDigest)
    || !Number.isSafeInteger(marker.graphRevision) || Number(marker.graphRevision) < 1
    || state.scoutedJobs === undefined || !Array.isArray(state.scoutedJobs) || state.scoutedJobs.length !== 0
    || state.scoredJobs === undefined || !Array.isArray(state.scoredJobs) || state.scoredJobs.length !== 0
    || state.analysisFailed !== 0 || !['prepare', 'gate', 'execute', 'audit', 'completed'].includes(String(state.nextStage))) return false
  return true
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function continuationOwner(value: unknown, ctx: PipelineCtx): boolean {
  const owner = record(value)
  if (!owner || !hasExactKeys(owner, OWNER_KEYS)
    || ![owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validId)
    || !Number.isSafeInteger(owner.rootAttemptCount) || Number(owner.rootAttemptCount) < 1
    || !Number.isSafeInteger(owner.turnLeaseVersion) || Number(owner.turnLeaseVersion) < 1
    || !Number.isSafeInteger(owner.executionAttemptCount) || Number(owner.executionAttemptCount) < 0) return false
  return owner.userId === ctx.userId && owner.sessionId === ctx.sessionId && owner.turnId === ctx.turnId
    && owner.executionId === ctx.executionAttempt?.id && owner.executionAttemptCount === ctx.executionAttempt?.attemptCount
}
function sameContinuationOwner(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return OWNER_KEYS.every(key => left[key] === right[key])
}
