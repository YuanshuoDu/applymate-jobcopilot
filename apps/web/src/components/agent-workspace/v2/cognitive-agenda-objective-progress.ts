import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared/agent-location-normalization"

const SNAPSHOT_SCHEMA = "agent-harness.v2.objective-progress.v1"
const DELTA_SCHEMA = "agent-harness.v2.objective-progress-delta.v1"
const MAX_REQUIREMENTS = 8
const STATUSES = ["missing", "active", "failed", "unverified", "reported_passed", "unknown"] as const
const NUMERIC_KINDS = ["candidate_count_gte", "finding_count_gte"] as const

export type CognitiveAgendaObjectiveProgressStatus = typeof STATUSES[number]
export type CognitiveAgendaObjectiveProgressKind = typeof NUMERIC_KINDS[number] | "candidate_location_in"
export type CognitiveAgendaObjectiveProgressRow = Readonly<{
  kind: CognitiveAgendaObjectiveProgressKind
  status: CognitiveAgendaObjectiveProgressStatus
  minimum?: number
  beforeStatus?: CognitiveAgendaObjectiveProgressStatus
}>

type Row = Record<string, unknown>
type Requirement = Readonly<{
  id: string
  kind: CognitiveAgendaObjectiveProgressKind
  status: CognitiveAgendaObjectiveProgressStatus
  minimum?: number
  locations?: readonly string[]
}>
type DeltaRequirement = Readonly<{
  id: string
  kind: CognitiveAgendaObjectiveProgressKind
  beforeStatus: CognitiveAgendaObjectiveProgressStatus
  afterStatus: CognitiveAgendaObjectiveProgressStatus
  minimum?: number
}>

function record(value: unknown): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Row : undefined
  } catch { return undefined }
}

function data(row: Row, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key)
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
}

function exact(row: Row, keys: readonly string[]): boolean {
  try {
    const ownKeys = Reflect.ownKeys(row)
    return ownKeys.length === keys.length && ownKeys.every(key => typeof key === "string" && keys.includes(key))
      && keys.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(row, key)
        return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value")
      })
  } catch { return false }
}

function denseArray(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
    const length = Object.getOwnPropertyDescriptor(value, "length")
    if (!length || !Object.hasOwn(length, "value") || typeof length.value !== "number"
      || !Number.isSafeInteger(length.value) || length.value > MAX_REQUIREMENTS) return undefined
    const size = length.value
    if (Reflect.ownKeys(value).length !== size + 1) return undefined
    const rows: unknown[] = []
    for (let index = 0; index < size; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined
      rows.push(descriptor.value)
    }
    return rows
  } catch { return undefined }
}

function safeRevision(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(value)
}

function safeStatus(value: unknown): value is CognitiveAgendaObjectiveProgressStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value)
}

function canonicalLocations(value: unknown): readonly string[] | undefined {
  const rows = denseArray(value)
  if (!rows) return undefined
  const locations = normalizeAgentLocationAllowlist(rows)
  return locations && rows.length === locations.length && rows.every((location, index) => location === locations[index])
    ? locations : undefined
}

function snapshotRequirement(value: unknown): Requirement | undefined {
  const row = record(value)
  if (!row) return undefined
  const kind = data(row, "kind"), id = data(row, "id"), status = data(row, "status")
  if (!safeId(id) || !safeStatus(status)) return undefined
  if (kind === "candidate_location_in") {
    if (!exact(row, ["id", "kind", "locations", "status"])) return undefined
    const locations = canonicalLocations(data(row, "locations"))
    return locations ? { id, kind, status, locations } : undefined
  }
  const minimum = data(row, "minimum")
  if (!(NUMERIC_KINDS as readonly unknown[]).includes(kind) || !exact(row, ["id", "kind", "minimum", "status"])
    || typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > 50) return undefined
  return { id, kind: kind as typeof NUMERIC_KINDS[number], status, minimum }
}

function deltaRequirement(value: unknown): DeltaRequirement | undefined {
  const row = record(value)
  if (!row) return undefined
  const kind = data(row, "kind"), id = data(row, "id")
  const beforeStatus = data(row, "beforeStatus"), afterStatus = data(row, "afterStatus")
  if (!safeId(id) || !safeStatus(beforeStatus) || !safeStatus(afterStatus)) return undefined
  if (kind === "candidate_location_in") {
    if (!exact(row, ["id", "kind", "beforeStatus", "afterStatus"])) return undefined
    return { id, kind, beforeStatus, afterStatus }
  }
  const minimum = data(row, "minimum")
  if (!(NUMERIC_KINDS as readonly unknown[]).includes(kind) || !exact(row, ["id", "kind", "minimum", "beforeStatus", "afterStatus"])
    || typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > 50) return undefined
  return { id, kind: kind as typeof NUMERIC_KINDS[number], minimum, beforeStatus, afterStatus }
}

function projectedRequirement(value: unknown): CognitiveAgendaObjectiveProgressRow | undefined {
  const row = record(value)
  if (!row) return undefined
  const kind = data(row, "kind"), status = data(row, "status")
  if (!safeStatus(status)) return undefined
  let beforeStatus: CognitiveAgendaObjectiveProgressStatus | undefined
  const hasBefore = Object.hasOwn(row, "beforeStatus")
  if (hasBefore) {
    const candidate = data(row, "beforeStatus")
    if (!safeStatus(candidate) || candidate === status) return undefined
    beforeStatus = candidate
  }
  const keys = hasBefore ? ["kind", "status", "beforeStatus"] : ["kind", "status"]
  if (kind === "candidate_location_in") {
    if (!exact(row, keys)) return undefined
    return { kind, status, ...(beforeStatus === undefined ? {} : { beforeStatus }) }
  }
  const minimum = data(row, "minimum")
  if (!(NUMERIC_KINDS as readonly unknown[]).includes(kind) || !exact(row, [...keys, "minimum"])
    || typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > 50) return undefined
  return { kind: kind as typeof NUMERIC_KINDS[number], status, minimum, ...(beforeStatus === undefined ? {} : { beforeStatus }) }
}

function requirements<T extends { id: string }>(value: unknown, parse: (value: unknown) => T | undefined): T[] | undefined {
  const values = denseArray(value)
  if (!values) return undefined
  const rows: T[] = []
  for (const item of values) {
    const row = parse(item)
    if (!row || rows.some(previous => previous.id === row.id)) return undefined
    rows.push(row)
  }
  return rows
}

/** Validates the exact Worker V2 progress receipt and returns only safe display fields. */
export function parseCognitiveAgendaObjectiveProgress(value: unknown): readonly CognitiveAgendaObjectiveProgressRow[] | null {
  try {
    const receipt = record(value)
    if (!receipt) return null
    const goalRevision = data(receipt, "goalRevision"), planRevision = data(receipt, "planRevision")
    const rawSnapshot = data(receipt, "objectiveProgressSnapshot"), rawDelta = record(data(receipt, "progressDelta"))
    if (!(goalRevision === null || typeof goalRevision === "string" && /^[a-f0-9]{64}$/.test(goalRevision))
      || !safeRevision(planRevision) || !rawDelta || !exact(rawDelta, ["schemaVersion", "availability", "previousPlanRevision", "currentPlanRevision", "requirements"])) return null

    const availability = data(rawDelta, "availability"), previousRevision = data(rawDelta, "previousPlanRevision")
    const currentRevision = data(rawDelta, "currentPlanRevision"), rawDeltaRows = data(rawDelta, "requirements")
    const deltaRows = requirements(rawDeltaRows, deltaRequirement)
    if (data(rawDelta, "schemaVersion") !== DELTA_SCHEMA
      || availability !== "available" && availability !== "unavailable"
      || !safeRevision(previousRevision) || !safeRevision(currentRevision) || currentRevision !== planRevision || !deltaRows
      || goalRevision === null && availability !== "unavailable"
      || availability === "available" && (previousRevision === null || planRevision === null || previousRevision > planRevision)
      || availability === "unavailable" && (previousRevision !== null || deltaRows.some(row => row.beforeStatus !== "unknown"))) return null

    if (rawSnapshot === null) {
      return availability === "unavailable" && previousRevision === null && deltaRows.length === 0 ? [] : null
    }
    const snapshot = record(rawSnapshot)
    if (!snapshot || !exact(snapshot, ["schemaVersion", "advisory", "revision", "requirements"])) return null
    const revision = data(snapshot, "revision"), rawRows = data(snapshot, "requirements")
    const snapshotRows = requirements(rawRows, snapshotRequirement)
    if (data(snapshot, "schemaVersion") !== SNAPSHOT_SCHEMA || data(snapshot, "advisory") !== true
      || !safeRevision(revision) || !snapshotRows || revision !== null && revision !== planRevision
      || revision !== null && currentRevision !== revision || revision === null && availability !== "unavailable"
      || snapshotRows.length !== deltaRows.length) return null

    const output: CognitiveAgendaObjectiveProgressRow[] = []
    for (let index = 0; index < snapshotRows.length; index += 1) {
      const current = snapshotRows[index]!, change = deltaRows[index]!
      if (current.id !== change.id || current.kind !== change.kind || current.status !== change.afterStatus
        || current.kind !== "candidate_location_in" && current.minimum !== change.minimum
        || revision === null && current.status !== "unknown") return null
      output.push({ kind: current.kind, status: current.status,
        ...(current.minimum === undefined ? {} : { minimum: current.minimum }),
        ...(availability === "available" && change.beforeStatus !== current.status ? { beforeStatus: change.beforeStatus } : {}),
      })
    }
    return output
  } catch { return null }
}

/** Revalidates the location-free, normalized projection carried through timeline hydration. */
export function parseCognitiveAgendaObjectiveProgressRows(value: unknown): readonly CognitiveAgendaObjectiveProgressRow[] | null {
  const values = denseArray(value)
  if (!values) return null
  const rows: CognitiveAgendaObjectiveProgressRow[] = []
  for (const value of values) {
    const row = projectedRequirement(value)
    if (!row) return null
    rows.push(row)
  }
  return rows
}
