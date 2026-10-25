import { describe, expect, it } from 'vitest'
import type { PipelineCtx } from './pipeline-context'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { isScheduledTaskGraphAuditRuntime, markScheduledTaskGraphAuditRuntime } from './scheduled-taskgraph-audit-runtime'

const owner: ScheduledTaskGraphPipelineOwner = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1', rootAttemptCount: 2,
  turnLeaseOwnerId: 'lease-owner', turnLeaseVersion: 4, executionId: 'execution-1', executionAttemptCount: 3,
}
const key = `scheduled-taskgraph:sha256:${'a'.repeat(64)}`
const claimToken = 'claim-token-1'
const invalidCode = 'scheduled_taskgraph_audit_runtime_invalid'

function context(): PipelineCtx {
  const claim = { schemaVersion: 'agent-harness.v2.scheduled-pipeline-claim.v1', key, claimToken,
    owner: { ...owner }, claimedAt: '2026-10-25T10:00:00.000Z', leaseExpiresAt: '2026-10-25T10:05:00.000Z' }
  const continuation = { schemaVersion: 'agent-harness.v2.scheduled-pipeline-continuation.v1', key,
    owner: { ...owner }, snapshotDigest: `sha256:${'b'.repeat(64)}`, graphRevision: 8, evidenceDigest: 'c'.repeat(64) }
  const ctx = {
    userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    agentCfg: {} as PipelineCtx['agentCfg'], roleConfigs: {} as PipelineCtx['roleConfigs'],
    resumeText: '', resumeContent: {} as PipelineCtx['resumeContent'],
    defaultResume: { id: 'resume-1', name: 'Resume', templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: { provider: 'minimax', model: 'MiniMax-M3' } as PipelineCtx['aiConfig'],
    autonomous: false, emit: () => undefined, executionAttempt: { id: owner.executionId, attemptCount: owner.executionAttemptCount },
    scheduledTaskGraphOwnerFence: { owner: { ...owner }, key, claimToken, assertCurrent: async () => true },
    resumeState: { nextStage: 'execute' as const, scheduledTaskGraphClaim: claim, scheduledTaskGraphContinuation: continuation },
  }
  return ctx as PipelineCtx
}

describe('scheduled TaskGraph Audit runtime marker', () => {
  it('marks only the final context and ignores user-shaped flags and spread copies', () => {
    const unmarked = context()
    const jsonFlag = Object.assign(context(), { scheduledTaskGraphAuditRuntime: true })
    expect(isScheduledTaskGraphAuditRuntime(unmarked)).toBe(false)
    expect(isScheduledTaskGraphAuditRuntime(jsonFlag)).toBe(false)

    markScheduledTaskGraphAuditRuntime(unmarked)
    expect(isScheduledTaskGraphAuditRuntime(unmarked)).toBe(true)
    expect(isScheduledTaskGraphAuditRuntime({ ...unmarked })).toBe(false)
  })

  it('rejects an equal-looking replacement fence reference', () => {
    const ctx = context()
    markScheduledTaskGraphAuditRuntime(ctx)
    ctx.scheduledTaskGraphOwnerFence = { ...ctx.scheduledTaskGraphOwnerFence! }
    expect(() => isScheduledTaskGraphAuditRuntime(ctx)).toThrow(invalidCode)
  })

  it.each(['key', 'claimToken'] as const)('rejects mutation of the captured fence %s', field => {
    const ctx = context()
    markScheduledTaskGraphAuditRuntime(ctx)
    const fence = ctx.scheduledTaskGraphOwnerFence!
    if (field === 'key') fence.key = `${key}-changed`
    else fence.claimToken = `${claimToken}-changed`
    expect(() => isScheduledTaskGraphAuditRuntime(ctx)).toThrow(invalidCode)
  })

  it('rejects owner and execution-lineage changes after marking', () => {
    const changedOwner = context()
    markScheduledTaskGraphAuditRuntime(changedOwner)
    changedOwner.scheduledTaskGraphOwnerFence!.owner.rootTaskId = 'other-root'
    expect(() => isScheduledTaskGraphAuditRuntime(changedOwner)).toThrow(invalidCode)

    const changedExecution = context()
    markScheduledTaskGraphAuditRuntime(changedExecution)
    changedExecution.executionAttempt = { id: 'other-execution', attemptCount: owner.executionAttemptCount }
    expect(() => isScheduledTaskGraphAuditRuntime(changedExecution)).toThrow(invalidCode)
  })

  it('requires execute or audit state and the matching persisted claim lineage', () => {
    const wrongStage = context()
    markScheduledTaskGraphAuditRuntime(wrongStage)
    wrongStage.resumeState = { ...wrongStage.resumeState!, nextStage: 'gate' }
    expect(() => isScheduledTaskGraphAuditRuntime(wrongStage)).toThrow(invalidCode)

    const wrongClaim = context()
    wrongClaim.resumeState = { ...wrongClaim.resumeState!, scheduledTaskGraphClaim: {
      ...wrongClaim.resumeState!.scheduledTaskGraphClaim!, claimToken: 'other-claim' } }
    expect(() => markScheduledTaskGraphAuditRuntime(wrongClaim)).toThrow(invalidCode)

    const wrongContext = context()
    wrongContext.turnId = 'other-turn'
    expect(() => markScheduledTaskGraphAuditRuntime(wrongContext)).toThrow(invalidCode)
  })

  it('rejects malformed re-marking rather than replacing the original authority snapshot', () => {
    const ctx = context()
    markScheduledTaskGraphAuditRuntime(ctx)
    ctx.scheduledTaskGraphOwnerFence!.key = `${key}-changed`
    expect(() => markScheduledTaskGraphAuditRuntime(ctx)).toThrow(invalidCode)
  })
})
