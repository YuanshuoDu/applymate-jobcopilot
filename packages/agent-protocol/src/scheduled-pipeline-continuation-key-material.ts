import type { ScheduledPipelineAttestation, ScheduledPipelineDiscoveryReceipt } from './scheduled-pipeline-attestation.js'

export type ScheduledPipelineExecutionIdentity = Readonly<{ executionId: string; executionAttemptCount: number }>
export type ScheduledPipelinePrepareReceiptKeyBinding = Readonly<{
  owner: Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number; executionId: string; executionAttemptCount: number }>
  continuationKey: string
  snapshotDigest: string
  evidenceDigest: string
  checkpointDigest: string
  analyzeGraphRevision: number
  prepareScheduleRevision: number
}>
export type ScheduledPipelineContinuationKeyMaterial = Readonly<{
  version: 'v1' | 'v2'
  keyPrefix: 'scheduled-taskgraph:sha256:' | 'scheduled-taskgraph:v2:sha256:'
  serializedPreimage: string
}>

export function scheduledPipelineContinuationKeyVersion(value: unknown): 'v1' | 'v2' | null {
  if (typeof value !== 'string') return null
  const v1 = 'scheduled-taskgraph:sha256:'
  const v2 = 'scheduled-taskgraph:v2:sha256:'
  if (value.startsWith(v1) && value.length === v1.length + 64 && /^[a-f0-9]{64}$/.test(value.slice(v1.length))) return 'v1'
  if (value.startsWith(v2) && value.length === v2.length + 64 && /^[a-f0-9]{64}$/.test(value.slice(v2.length))) return 'v2'
  return null
}

/** Pure shared preimage projection. Hashing and all current-proof checks stay in Worker/Web. */
export function scheduledPipelineContinuationKeyMaterial(
  attestation: ScheduledPipelineAttestation,
  execution: ScheduledPipelineExecutionIdentity,
): ScheduledPipelineContinuationKeyMaterial {
  const { owner } = attestation
  const base = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
    execution.executionId, execution.executionAttemptCount, attestation.snapshotDigest, attestation.graphRevision]
  if (attestation.schemaVersion === 'agent-harness.v2.scheduled-pipeline-attestation.v1') {
    const preimage = [...base, attestation.scout.taskId, attestation.scout.attemptCount, attestation.scout.resultDigest,
      attestation.analyst.taskId, attestation.analyst.attemptCount, attestation.analyst.resultDigest,
      attestation.evidenceDigest, attestation.scout.discoveryReceipt.receiptDigest]
    return { version: 'v1', keyPrefix: 'scheduled-taskgraph:sha256:', serializedPreimage: JSON.stringify(preimage) }
  }
  const scouts = attestation.scouts.map(source => [source.nodeKey, source.taskId, source.attemptCount, source.status,
    source.verification, source.resultDigest, source.nodeDigest, source.evidenceDigest, source.reportDigest,
    source.candidateJobIds, receiptProjection(source.discoveryReceipt)])
  const analyst = [attestation.analyst.nodeKey, attestation.analyst.taskId, attestation.analyst.attemptCount,
    attestation.analyst.status, attestation.analyst.verification, attestation.analyst.resultDigest,
    attestation.analyst.nodeDigest, attestation.analyst.evidenceDigest, attestation.analyst.reportDigest,
    attestation.analyst.dependsOnTaskIds, attestation.analyst.jobIds]
  const preimage = ['agent-harness.v2.scheduled-pipeline-attestation.v2', ...base, scouts,
    attestation.candidateUnionJobIds, analyst, attestation.evidenceDigest]
  return { version: 'v2', keyPrefix: 'scheduled-taskgraph:v2:sha256:', serializedPreimage: JSON.stringify(preimage) }
}

/** Pure stable Prepare-receipt preimage projection; version follows the already-validated Analyze key. */
export function scheduledPipelinePrepareReceiptKeyMaterial(
  binding: ScheduledPipelinePrepareReceiptKeyBinding,
): ScheduledPipelineContinuationKeyMaterial | null {
  const version = scheduledPipelineContinuationKeyVersion(binding.continuationKey)
  if (!version) return null
  const owner = binding.owner
  const base = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
    owner.executionId, owner.executionAttemptCount, binding.snapshotDigest, binding.evidenceDigest, binding.checkpointDigest,
    binding.analyzeGraphRevision, binding.prepareScheduleRevision]
  const serializedPreimage = JSON.stringify(version === 'v1' ? base : ['agent-harness.v2.scheduled-taskgraph-prepare-receipt.v2', ...base])
  return { version, keyPrefix: version === 'v1' ? 'scheduled-taskgraph:sha256:' : 'scheduled-taskgraph:v2:sha256:', serializedPreimage }
}

function receiptProjection(receipt: ScheduledPipelineDiscoveryReceipt): readonly (string | number | boolean)[] {
  return [receipt.status, receipt.taskId, receipt.attemptCount, receipt.completedCalls, receipt.candidateCount,
    receipt.providerFailures, receipt.materializationFailures, receipt.hasMore, receipt.receiptDigest]
}
