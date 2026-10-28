import { parseScheduledPipelineAttestation, type ScheduledPipelineAttestation } from "@jobcopilot/agent-protocol"

export type ScheduledTaskGraphCandidateSelection = Readonly<{
  version: "v1" | "v2"
  candidateUnionJobIds: readonly string[]
  selectedJobIds: readonly string[]
}>

export function parseScheduledTaskGraphAttestation(value: unknown): ScheduledPipelineAttestation | null {
  return parseScheduledPipelineAttestation(value)
}

export function scheduledTaskGraphAttestationCandidates(
  attestation: ScheduledPipelineAttestation,
): ScheduledTaskGraphCandidateSelection {
  if (attestation.schemaVersion === "agent-harness.v2.scheduled-pipeline-attestation.v1") {
    return { version: "v1", candidateUnionJobIds: attestation.scout.candidateJobIds,
      selectedJobIds: attestation.scout.candidateJobIds }
  }
  return { version: "v2", candidateUnionJobIds: attestation.candidateUnionJobIds,
    selectedJobIds: attestation.analyst.jobIds }
}
