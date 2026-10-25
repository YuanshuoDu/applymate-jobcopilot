import type { PipelineCtx } from './pipeline-context'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

const AUDIT_RUNTIME = Symbol('scheduled-taskgraph-audit-runtime')
const INVALID = 'scheduled_taskgraph_audit_runtime_invalid'
const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId',
  'turnLeaseVersion', 'executionId', 'executionAttemptCount'] as const
const CLAIM_SCHEMA = 'agent-harness.v2.scheduled-pipeline-claim.v1'
const CONTINUATION_SCHEMA = 'agent-harness.v2.scheduled-pipeline-continuation.v1'
const KEY = /^scheduled-taskgraph:sha256:[a-f0-9]{64}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const HEX = /^[a-f0-9]{64}$/

type Fence = NonNullable<PipelineCtx['scheduledTaskGraphOwnerFence']>
type OwnerSnapshot = Readonly<ScheduledTaskGraphPipelineOwner>
type RuntimeMark = Readonly<{ context: PipelineCtx; fence: Fence; owner: OwnerSnapshot; key: string; claimToken: string }>
type BrandedContext = PipelineCtx & { [AUDIT_RUNTIME]?: RuntimeMark }

/** Marks the exact, validated final context for a scheduled Audit runtime. */
export function markScheduledTaskGraphAuditRuntime(ctx: PipelineCtx): void {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(ctx, AUDIT_RUNTIME)
    if (descriptor) {
      if (!validDescriptor(descriptor) || !validMarker(ctx, descriptor.value)) invalid()
      return
    }
    const fence = ctx.scheduledTaskGraphOwnerFence
    const owner = fence?.owner
    if (!fence || !validFence(ctx, fence, owner)) invalid()
    Object.defineProperty(ctx as BrandedContext, AUDIT_RUNTIME, { value: Object.freeze({
      context: ctx, fence, owner: Object.freeze({ ...owner }), key: fence.key, claimToken: fence.claimToken,
    }), enumerable: false, configurable: false, writable: false })
  } catch { invalid() }
}

/** Returns false only when the context has no private runtime mark. */
export function isScheduledTaskGraphAuditRuntime(ctx: PipelineCtx): boolean {
  if (!ctx || typeof ctx !== 'object') return false
  let descriptor: PropertyDescriptor | undefined
  try { descriptor = Object.getOwnPropertyDescriptor(ctx, AUDIT_RUNTIME) } catch { invalid() }
  if (!descriptor) return false
  if (!validDescriptor(descriptor) || !validMarker(ctx, descriptor.value)) invalid()
  return true
}

function validDescriptor(value: PropertyDescriptor): boolean {
  return Object.hasOwn(value, 'value') && value.enumerable === false
    && value.configurable === false && value.writable === false
}

function validMarker(ctx: PipelineCtx, value: unknown): value is RuntimeMark {
  const mark = record(value), fence = ctx.scheduledTaskGraphOwnerFence
  return !!mark && mark.context === ctx && !!fence && mark.fence === fence
    && validFence(ctx, fence, mark.owner) && mark.key === fence.key && mark.claimToken === fence.claimToken
}

function validFence(ctx: PipelineCtx, fence: Fence, expectedOwner: unknown): boolean {
  const owner = record(fence.owner), state = record(ctx.resumeState), claim = record(state?.scheduledTaskGraphClaim)
  const claimOwner = record(claim?.owner), continuation = record(state?.scheduledTaskGraphContinuation)
  const continuationOwner = record(continuation?.owner), expected = record(expectedOwner)
  if (!owner || !expected || !sameOwner(owner, expected) || !validOwner(owner)
    || !validId(fence.key) || !KEY.test(fence.key) || !validId(fence.claimToken)
    || typeof fence.assertCurrent !== 'function' || !state || !['execute', 'audit'].includes(String(state.nextStage))
    || ctx.userId !== owner.userId || ctx.sessionId !== owner.sessionId || ctx.turnId !== owner.turnId
    || ctx.executionAttempt?.id !== owner.executionId || ctx.executionAttempt?.attemptCount !== owner.executionAttemptCount
    || !claim || !claimOwner || !exactKeys(claim, ['schemaVersion', 'key', 'claimToken', 'owner', 'claimedAt', 'leaseExpiresAt'])
    || claim.schemaVersion !== CLAIM_SCHEMA || claim.key !== fence.key || claim.claimToken !== fence.claimToken
    || !sameOwner(claimOwner, owner) || !validTimestamp(claim.claimedAt) || !validTimestamp(claim.leaseExpiresAt)
    || Date.parse(String(claim.leaseExpiresAt)) <= Date.parse(String(claim.claimedAt))
    || !continuation || !continuationOwner
    || !exactKeys(continuation, ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
    || continuation.schemaVersion !== CONTINUATION_SCHEMA || continuation.key !== fence.key
    || !sameOwner(continuationOwner, owner) || !DIGEST.test(String(continuation.snapshotDigest))
    || !positive(continuation.graphRevision) || !HEX.test(String(continuation.evidenceDigest))) return false
  return true
}

function validOwner(value: Record<string, unknown>): value is Record<string, unknown> & ScheduledTaskGraphPipelineOwner {
  return exactKeys(value, OWNER_KEYS) && [value.userId, value.sessionId, value.turnId, value.rootTaskId,
    value.turnLeaseOwnerId, value.executionId].every(validId) && positive(value.rootAttemptCount)
    && positive(value.turnLeaseVersion) && nonNegative(value.executionAttemptCount)
}

function sameOwner(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return exactKeys(left, OWNER_KEYS) && exactKeys(right, OWNER_KEYS) && OWNER_KEYS.every(key => left[key] === right[key])
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    return Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) ? value as Record<string, unknown> : null
  } catch { return null }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function validTimestamp(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function invalid(): never { throw new Error(INVALID) }
