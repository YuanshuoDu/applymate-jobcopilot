/** Stable ordering and completion checks for paged timeline hydration. */

export function sortTimelineTailEvents(left: unknown, right: unknown): number {
  const leftSequence = tailSequence(left)
  const rightSequence = tailSequence(right)
  if (leftSequence !== null && rightSequence !== null) {
    const bySequence = BigInt(leftSequence) < BigInt(rightSequence) ? -1 : BigInt(leftSequence) > BigInt(rightSequence) ? 1 : 0
    if (bySequence !== 0) return bySequence
  } else if (leftSequence !== null) return -1
  else if (rightSequence !== null) return 1
  return tailId(left).localeCompare(tailId(right))
}

export function hasAllTimelineTargetItems(items: readonly unknown[], targetItemIds: ReadonlySet<string>): boolean {
  const found = new Set<string>()
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const id = (item as { id?: unknown }).id
    if (typeof id === 'string' && targetItemIds.has(id)) found.add(id)
  }
  return found.size === targetItemIds.size
}

function tailSequence(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const sequence = (value as { sequence?: unknown }).sequence
  return typeof sequence === 'string' && /^(0|[1-9]\d*)$/.test(sequence) && sequence.length <= 39 ? sequence : null
}

function tailId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}
