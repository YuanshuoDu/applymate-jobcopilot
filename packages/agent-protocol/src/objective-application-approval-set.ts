export const OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA = 'objective-application-approval-set.v1' as const

export type ObjectiveApplicationApprovalSet = Readonly<{
  schema: typeof OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA
  waitKind: 'approval_set'
  setId: string
  sourceTurnId: string
  intentHash: string
  expiresAt: string
  members: readonly Readonly<{ slotOrdinal: number; approvalId: string }>[]
}>

const SET_KEYS = ['schema', 'waitKind', 'setId', 'sourceTurnId', 'intentHash', 'expiresAt', 'members'] as const
const MEMBER_KEYS = ['slotOrdinal', 'approvalId'] as const
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const ITEM_PREFIX = 'agent-wait:approval-set:'

/** Parses the exact bounded wait payload used to project one multi-approval item. */
export function parseObjectiveApplicationApprovalSet(value: unknown): ObjectiveApplicationApprovalSet | null {
  const set = closedRecord(value, SET_KEYS)
  if (!set || set.schema !== OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA || set.waitKind !== 'approval_set'
    || !normalId(set.setId) || !normalId(set.sourceTurnId) || typeof set.intentHash !== 'string'
    || !HASH_PATTERN.test(set.intentHash) || !canonicalIso(set.expiresAt)) return null

  const rawMembers = denseArray(set.members, 1, 8)
  if (!rawMembers) return null
  const members: Array<Readonly<{ slotOrdinal: number; approvalId: string }>> = []
  const approvalIds = new Set<string>()
  let previousOrdinal = 0
  for (const value of rawMembers) {
    const member = closedRecord(value, MEMBER_KEYS)
    if (!member || !Number.isSafeInteger(member.slotOrdinal) || Number(member.slotOrdinal) < 1
      || Number(member.slotOrdinal) > 8 || Number(member.slotOrdinal) <= previousOrdinal
      || !normalId(member.approvalId) || approvalIds.has(member.approvalId)) return null
    const slotOrdinal = Number(member.slotOrdinal)
    previousOrdinal = slotOrdinal
    approvalIds.add(member.approvalId)
    members.push(Object.freeze({ slotOrdinal, approvalId: member.approvalId }))
  }

  return Object.freeze({
    schema: OBJECTIVE_APPLICATION_APPROVAL_SET_SCHEMA,
    waitKind: 'approval_set',
    setId: set.setId,
    sourceTurnId: set.sourceTurnId,
    intentHash: set.intentHash,
    expiresAt: set.expiresAt,
    members: Object.freeze(members),
  })
}

/** Returns the stable transcript item ID for a validated approval-set ID. */
export function objectiveApplicationApprovalSetItemId(setId: string): string {
  if (!normalId(setId)) throw new TypeError('Invalid objective application approval set ID')
  return `${ITEM_PREFIX}${setId}`
}

function normalId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && ID_PATTERN.test(value)
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function denseArray(value: unknown, min: number, max: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < min || value.length > max) return null
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length'
      && (typeof key !== 'string' || !/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= value.length))) return null
    const rows: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      rows.push(descriptor.value)
    }
    return rows
  } catch { return null }
}
