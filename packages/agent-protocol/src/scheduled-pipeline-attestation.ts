import { parseScheduledPipelineAttestationValue } from './scheduled-pipeline-attestation-validation.js'

export const SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA = 'agent-harness.v2.scheduled-pipeline-attestation.v1' as const
export const SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA = 'agent-harness.v2.scheduled-pipeline-attestation.v2' as const

export type ScheduledPipelineAttestationOwner = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  rootAttemptCount: number
  turnLeaseOwnerId: string
  turnLeaseVersion: number
}>

/** V1 keeps the historical structural shape; receipt completeness remains a consumer classification. */
export type ScheduledPipelineDiscoveryReceipt = Readonly<{
  status: 'complete'
  taskId: string
  attemptCount: number
  completedCalls: number
  candidateCount: number
  providerFailures: number
  materializationFailures: number
  hasMore: boolean
  receiptDigest: string
}>

export type ScheduledPipelineScoutAttestationV1 = Readonly<{
  taskId: string
  attemptCount: number
  status: 'completed'
  verification: 'passed'
  resultDigest: string
  candidateJobIds: readonly string[]
  discoveryReceipt: ScheduledPipelineDiscoveryReceipt
}>

export type ScheduledPipelineAnalystAttestationV1 = Readonly<{
  taskId: string
  attemptCount: number
  status: 'completed'
  verification: 'passed'
  resultDigest: string
  dependsOnTaskIds: readonly string[]
  jobIds: readonly string[]
}>

export type ScheduledPipelineAttestationV1 = Readonly<{
  schemaVersion: typeof SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA
  owner: ScheduledPipelineAttestationOwner
  snapshotDigest: string
  graphRevision: number
  scout: ScheduledPipelineScoutAttestationV1
  analyst: ScheduledPipelineAnalystAttestationV1
  evidenceDigest: string
}>

export type ScheduledPipelineScoutProofV2 = Readonly<{
  nodeKey: string
  taskId: string
  attemptCount: number
  status: 'completed'
  verification: 'passed'
  resultDigest: string
  nodeDigest: string
  evidenceDigest: string
  reportDigest: string
  candidateJobIds: readonly string[]
  discoveryReceipt: ScheduledPipelineDiscoveryReceipt
}>

export type ScheduledPipelineAnalystProofV2 = Readonly<{
  nodeKey: string
  taskId: string
  attemptCount: number
  status: 'completed'
  verification: 'passed'
  resultDigest: string
  nodeDigest: string
  evidenceDigest: string
  reportDigest: string
  dependsOnTaskIds: readonly string[]
  jobIds: readonly string[]
}>

export type ScheduledPipelineAttestationV2 = Readonly<{
  schemaVersion: typeof SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA
  owner: ScheduledPipelineAttestationOwner
  snapshotDigest: string
  graphRevision: number
  scouts: readonly ScheduledPipelineScoutProofV2[]
  candidateUnionJobIds: readonly string[]
  analyst: ScheduledPipelineAnalystProofV2
  evidenceDigest: string
}>

export type ScheduledPipelineAttestation = ScheduledPipelineAttestationV1 | ScheduledPipelineAttestationV2

/** Structural wire parsing only. Callers must still establish current ownership and proof lineage. */
export function parseScheduledPipelineAttestation(value: unknown): ScheduledPipelineAttestation | null {
  return parseScheduledPipelineAttestationValue(value)
}
