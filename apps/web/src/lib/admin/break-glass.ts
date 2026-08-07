import { isPermission, type Permission } from './permissions'

export function parseBreakGlassRequest(value: unknown): { permission: Permission; durationMinutes: number } | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const permission = typeof input.permission === 'string' && isPermission(input.permission) ? input.permission : null
  const durationMinutes = typeof input.durationMinutes === 'number' && Number.isInteger(input.durationMinutes) ? input.durationMinutes : 0
  return permission && durationMinutes >= 5 && durationMinutes <= 60 ? { permission, durationMinutes } : null
}
