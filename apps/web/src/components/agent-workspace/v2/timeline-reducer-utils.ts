import type { TimelineItem } from './timeline-reducer'

export function buildIndexes(itemsById: Record<string, TimelineItem>) {
  const itemIdsByTurnId: Record<string, string[]> = {}
  const itemIdsByTaskId: Record<string, string[]> = {}
  for (const item of Object.values(itemsById)) {
    ;(itemIdsByTurnId[item.turnId] ??= []).push(item.id)
    if (item.taskId) (itemIdsByTaskId[item.taskId] ??= []).push(item.id)
  }
  for (const ids of Object.values(itemIdsByTurnId)) ids.sort()
  for (const ids of Object.values(itemIdsByTaskId)) ids.sort()
  return { itemIdsByTurnId, itemIdsByTaskId }
}

export function compareItems(a: TimelineItem, b: TimelineItem): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

export function mergeContent(current: unknown, incoming: unknown): unknown {
  if (!isRecord(current) || !isRecord(incoming)) return incoming
  return { ...current, ...incoming }
}

export function integer(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function timestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function sequence(value: unknown): string | null {
  return typeof value === 'string' && /^\d{1,39}$/.test(value) ? value : null
}

export function isAfter(left: string, right: string | null): boolean {
  return right === null || BigInt(left) > BigInt(right)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
