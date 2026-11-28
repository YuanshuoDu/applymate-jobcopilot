export const OBJECTIVE_WAVE_REQUIREMENT_QUOTE = "Required: TypeScript."
export const OBJECTIVE_WAVE_RUST_REQUIREMENT_QUOTE = "Required: Rust."

/** Cite only the exact phrase returned by a successful, matching jobs.get receipt. */
export function objectiveWaveRequirementCitation(receipt, expectedJobId, evidenceId) {
  const job = receipt?.error === false ? receipt.value?.job : undefined
  if (job?.id !== expectedJobId || typeof job.description !== "string"
    || !job.description) return undefined
  const quotes = [OBJECTIVE_WAVE_REQUIREMENT_QUOTE, OBJECTIVE_WAVE_RUST_REQUIREMENT_QUOTE]
    .filter(quote => job.description.includes(quote))
  return quotes.length ? { requirementCitations: quotes.map(quote => ({ evidenceId, quote })) } : undefined
}

export function objectiveWaveFinding(candidate, evidence, receipt) {
  return { jobId: candidate.jobId, score: 8, evidenceIds: [evidence.id],
    ...objectiveWaveRequirementCitation(receipt, candidate.jobId, evidence.id) }
}
