import { createHash } from 'node:crypto'
import { scheduledPipelineContinuationKeyMaterial, scheduledPipelinePrepareReceiptKeyMaterial } from '@jobcopilot/agent-protocol'
import type { ScheduledTaskGraphContinuationBinding, ScheduledTaskGraphContinuationOwner } from './scheduled-taskgraph-continuation-receipt.js'
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from './scheduled-automation-pipeline-bridge.js'

export { scheduledPipelineContinuationKeyVersion as scheduledTaskGraphContinuationKeyVersion } from '@jobcopilot/agent-protocol'

export function scheduledTaskGraphContinuationKey(
  owner: ScheduledAutomationPipelineBridgeScope,
  attestation: ScheduledAutomationPipelineAttestation,
  executionId: string,
  executionAttemptCount: number,
): string {
  const material = scheduledPipelineContinuationKeyMaterial({ ...attestation, owner: { ...owner } }, { executionId, executionAttemptCount })
  return `${material.keyPrefix}${createHash('sha256').update(material.serializedPreimage, 'utf8').digest('hex')}`
}

export function scheduledTaskGraphContinuationBindingDigestProjection(
  binding: ScheduledTaskGraphContinuationBinding,
): readonly (string | number)[] {
  return ['agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1', ...stableOwnerValues(binding.owner), binding.continuationKey, binding.snapshotDigest,
    binding.evidenceDigest, binding.checkpointDigest, binding.analyzeGraphRevision, binding.prepareScheduleRevision]
}

export function scheduledTaskGraphStableKey(binding: ScheduledTaskGraphContinuationBinding): string | null {
  const material = scheduledPipelinePrepareReceiptKeyMaterial(binding)
  return material ? `${material.keyPrefix}${createHash('sha256').update(material.serializedPreimage, 'utf8').digest('hex')}` : null
}

function stableOwnerValues(owner: ScheduledTaskGraphContinuationOwner): readonly (string | number)[] {
  return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount]
}
