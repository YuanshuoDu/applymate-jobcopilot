export const OBJECTIVE_TAILOR_PROGRESS_SCHEMA = 'agent-harness.v2.objective-tailor-progress.v1' as const
export const OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA = 'agent-harness.v2.objective-tailor-progress-hint.v1' as const

export type ObjectiveTailorProgressSourceStatus = 'pending' | 'running' | 'completed' | 'failed'
export type ObjectiveTailorProgressSlotPhase = 'awaiting_draft' | 'drafting' | 'awaiting_review' | 'reviewing'
  | 'awaiting_revision' | 'revising' | 'awaiting_rereview' | 'rereviewing' | 'completed' | 'failed'
export type ObjectiveTailorProgress = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_PROGRESS_SCHEMA
  identity: Readonly<{ sessionId: string; turnId: string; graphItemId: string; rootTaskId: string; revision: number }>
  sources: readonly Readonly<{ ordinal: number; role: 'scout' | 'analyst'; status: ObjectiveTailorProgressSourceStatus }>[]
  slots: readonly Readonly<{ ordinal: number; phase: ObjectiveTailorProgressSlotPhase }>[]
}>
export type ObjectiveTailorProgressHint = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA
  sourceNodeCount: number
  slotCount: number
}>

const sourceStatuses = new Set<string>(['pending', 'running', 'completed', 'failed'])
const slotPhases = new Set<string>(['awaiting_draft', 'drafting', 'awaiting_review', 'reviewing', 'awaiting_revision',
  'revising', 'awaiting_rereview', 'rereviewing', 'completed', 'failed'])

export function parseObjectiveTailorProgress(value: unknown): ObjectiveTailorProgress | undefined {
  try {
    const row = exactRecord(value, ['schemaVersion', 'identity', 'sources', 'slots'])
    const identity = row && exactRecord(row.identity, ['sessionId', 'turnId', 'graphItemId', 'rootTaskId', 'revision'])
    const sources = row && dense(row.sources, 2, 8), slots = row && dense(row.slots, 1, 8)
    if (!row || row.schemaVersion !== OBJECTIVE_TAILOR_PROGRESS_SCHEMA || !identity || !sources || !slots
      || !['sessionId', 'turnId', 'graphItemId', 'rootTaskId'].every(key => identifier(identity[key]))
      || !Number.isSafeInteger(identity.revision) || Number(identity.revision) < 1) return undefined
    const parsedSources = sources.map((entry, index) => {
      const source = exactRecord(entry, ['ordinal', 'role', 'status'])
      if (!source || source.ordinal !== index + 1 || (source.role !== 'scout' && source.role !== 'analyst')
        || typeof source.status !== 'string' || !sourceStatuses.has(source.status)) return undefined
      return { ordinal: index + 1, role: source.role as 'scout' | 'analyst', status: source.status as ObjectiveTailorProgressSourceStatus }
    })
    const parsedSlots = slots.map((entry, index) => {
      const slot = exactRecord(entry, ['ordinal', 'phase'])
      if (!slot || slot.ordinal !== index + 1 || typeof slot.phase !== 'string' || !slotPhases.has(slot.phase)) return undefined
      return { ordinal: index + 1, phase: slot.phase as ObjectiveTailorProgressSlotPhase }
    })
    if (parsedSources.some(value => !value) || parsedSlots.some(value => !value)) return undefined
    return { schemaVersion: OBJECTIVE_TAILOR_PROGRESS_SCHEMA,
      identity: { sessionId: identity.sessionId as string, turnId: identity.turnId as string,
        graphItemId: identity.graphItemId as string, rootTaskId: identity.rootTaskId as string, revision: Number(identity.revision) },
      sources: parsedSources as NonNullable<(typeof parsedSources)[number]>[],
      slots: parsedSlots as NonNullable<(typeof parsedSlots)[number]>[] }
  } catch { return undefined }
}

export function parseObjectiveTailorProgressHint(value: unknown): ObjectiveTailorProgressHint | undefined {
  try {
    const row = exactRecord(value, ['schemaVersion', 'sourceNodeCount', 'slotCount'])
    if (!row || row.schemaVersion !== OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA
      || !Number.isSafeInteger(row.sourceNodeCount) || Number(row.sourceNodeCount) < 2 || Number(row.sourceNodeCount) > 8
      || !Number.isSafeInteger(row.slotCount) || Number(row.slotCount) < 1 || Number(row.slotCount) > 8) return undefined
    return { schemaVersion: OBJECTIVE_TAILOR_PROGRESS_HINT_SCHEMA, sourceNodeCount: Number(row.sourceNodeCount), slotCount: Number(row.slotCount) }
  } catch { return undefined }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return undefined
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
  }
  return value as Record<string, unknown>
}

function dense(value: unknown, minimum: number, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string')) return undefined
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    result.push(descriptor.value)
  }
  return result
}
