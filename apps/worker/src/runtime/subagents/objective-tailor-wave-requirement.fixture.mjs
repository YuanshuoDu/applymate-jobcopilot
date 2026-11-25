export const OBJECTIVE_WAVE_REQUIREMENT_QUOTE = "Required: TypeScript."

/** Cite only the exact phrase returned by a successful, matching jobs.get receipt. */
export function objectiveWaveRequirementCitation(receipt, expectedJobId, evidenceId) {
  const job = receipt?.error === false ? receipt.value?.job : undefined
  if (job?.id !== expectedJobId || typeof job.description !== "string"
    || !job.description.includes(OBJECTIVE_WAVE_REQUIREMENT_QUOTE)) return undefined
  return { requirementCitations: [{ evidenceId, quote: OBJECTIVE_WAVE_REQUIREMENT_QUOTE }] }
}

export function objectiveWaveFinding(candidate, evidence, receipt) {
  return { jobId: candidate.jobId, score: 8, evidenceIds: [evidence.id],
    ...objectiveWaveRequirementCitation(receipt, candidate.jobId, evidence.id) }
}
