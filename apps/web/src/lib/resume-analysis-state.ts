export function analysisTargetKey(resumeId: string | null, jobId: string | null) {
  return resumeId && jobId ? `${resumeId}:${jobId}` : null
}

export function shouldPreserveAnalysis(activeTargetKey: string | null, targetKey: string | null) {
  return Boolean(targetKey && activeTargetKey === targetKey)
}

export function shouldStartAutomaticAnalysis({
  targetKey,
  activeTargetKey,
  hasScore,
  hasContent,
  hasJobs,
  contentChangedSinceAnalysis,
}: {
  targetKey: string | null
  activeTargetKey: string | null
  hasScore: boolean
  hasContent: boolean
  hasJobs: boolean
  contentChangedSinceAnalysis: boolean
}) {
  if (!targetKey || !hasContent || !hasJobs || contentChangedSinceAnalysis) return false
  return !(hasScore && activeTargetKey === targetKey)
}

export function replaceSectionSuggestions<T extends { target: string }>(
  suggestions: T[],
  section: string,
  replacement: T[],
) {
  return [...suggestions.filter(suggestion => suggestion.target !== section), ...replacement]
}
