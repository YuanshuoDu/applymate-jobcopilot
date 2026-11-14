/** Prevent a late result from replacing a newer or unorderable revision. */
export function mayUpdateAnalysisCache(stored: string | null | undefined, incoming: string): boolean {
  if (!stored || stored === incoming) return true
  const previous = Date.parse(stored)
  const next = Date.parse(incoming)
  return Number.isFinite(previous) && Number.isFinite(next) && next > previous
}
