export const SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION = "agent-harness.v2.scheduled-automation-snapshot.v1"

const SCHEDULED_AUTOMATION_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion", "targetRoles", "targetLocations", "minScore", "dailyCap", "requireApproval", "autoApply",
])

type Row = Record<string, unknown>

export type ScheduledAutomationCriteria = Readonly<{
  targetRoles: readonly string[]
  targetLocations: readonly string[]
  minScore: number
}>

export type ScheduledAutomationSnapshot = Readonly<ScheduledAutomationCriteria & {
  schemaVersion: typeof SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION
  dailyCap: number
  requireApproval: boolean
  autoApply: boolean
}>

function ownDataRecord(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const record: Row = Object.create(null) as Row
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
      record[key] = descriptor.value
    }
    return record
  } catch {
    return undefined
  }
}

function exactSnapshotRecord(value: unknown): Row | undefined {
  const record = ownDataRecord(value)
  if (!record || Object.keys(record).length !== SCHEDULED_AUTOMATION_SNAPSHOT_KEYS.length ||
    SCHEDULED_AUTOMATION_SNAPSHOT_KEYS.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return undefined
  return record
}

function boundedSnapshotList(value: unknown, minItems: number, maxItems: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) return undefined
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== value.length + 1 || ownKeys.some(key => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return undefined
  } catch {
    return undefined
  }
  const result: string[] = []
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index]
    if (typeof entry !== "string" || !entry.trim() || entry.length > 160) return undefined
    result.push(entry.trim())
  }
  return Object.freeze(result)
}

/** Validates the complete persisted scheduled-run snapshot before exposing its search criteria. */
export function parseScheduledAutomationSnapshot(value: unknown): ScheduledAutomationSnapshot | undefined {
  const snapshot = exactSnapshotRecord(value)
  if (!snapshot || snapshot.schemaVersion !== SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION) return undefined
  const targetRoles = boundedSnapshotList(snapshot.targetRoles, 1, 8)
  const targetLocations = boundedSnapshotList(snapshot.targetLocations, 0, 8)
  const minScore = snapshot.minScore
  const dailyCap = snapshot.dailyCap
  if (!targetRoles || !targetLocations || typeof minScore !== "number" || !Number.isInteger(minScore) || minScore < 0 || minScore > 100 ||
    typeof dailyCap !== "number" || !Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 50 ||
    typeof snapshot.requireApproval !== "boolean" || typeof snapshot.autoApply !== "boolean") return undefined
  return Object.freeze({
    schemaVersion: SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION,
    targetRoles,
    targetLocations,
    minScore,
    dailyCap,
    requireApproval: snapshot.requireApproval,
    autoApply: snapshot.autoApply,
  })
}

/** Returns search criteria only when the stored Turn input contains a complete valid snapshot. */
export function scheduledAutomationCriteria(turnInput: unknown): ScheduledAutomationCriteria | undefined {
  const input = ownDataRecord(turnInput)
  const snapshot = parseScheduledAutomationSnapshot(input?.scheduledAutomationSnapshot)
  return snapshot ? Object.freeze({
    targetRoles: snapshot.targetRoles,
    targetLocations: snapshot.targetLocations,
    minScore: snapshot.minScore,
  }) : undefined
}

/** Scheduled history compatibility is limited to persisted automation Turns in scheduled mode. */
export function isScheduledAutomationTurn(source: unknown, turnInput: unknown): boolean {
  const input = ownDataRecord(turnInput)
  return source === "automation" && input?.automationRunMode === "scheduled"
}

export function sameScheduledAutomationCriteria(
  left: ScheduledAutomationCriteria,
  right: ScheduledAutomationCriteria,
): boolean {
  return left.minScore === right.minScore
    && sameOrderedList(left.targetRoles, right.targetRoles)
    && sameOrderedList(left.targetLocations, right.targetLocations)
}

function sameOrderedList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const SQL_TRIM_CHARACTERS = "array_to_string(ARRAY[chr(9),chr(10),chr(11),chr(12),chr(13),chr(32),chr(160),chr(5760)," +
  "chr(8192),chr(8193),chr(8194),chr(8195),chr(8196),chr(8197),chr(8198),chr(8199),chr(8200),chr(8201),chr(8202)," +
  "chr(8232),chr(8233),chr(8239),chr(8287),chr(12288),chr(65279)], '')"
const SQL_SNAPSHOT_KEYS = "ARRAY['schemaVersion','targetRoles','targetLocations','minScore','dailyCap','requireApproval','autoApply']::text[]"

function sqlArrayValid(snapshot: string, key: "targetRoles" | "targetLocations", minimum: number): string {
  const array = `(${snapshot}->'${key}')`
  return `CASE WHEN jsonb_typeof(${array}) IS DISTINCT FROM 'array' THEN FALSE
    WHEN jsonb_array_length(${array}) < ${minimum} OR jsonb_array_length(${array}) > 8 THEN FALSE
    ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${array}) AS item(value)
      WHERE CASE WHEN jsonb_typeof(item.value) IS DISTINCT FROM 'string' THEN TRUE ELSE
        btrim(item.value #>> '{}', ${SQL_TRIM_CHARACTERS}) = '' OR
        char_length(item.value #>> '{}') + (SELECT count(*) FROM generate_series(0,
          octet_length(convert_to(item.value #>> '{}', 'UTF8')) - 1) AS utf8_byte(byte_index)
          WHERE get_byte(convert_to(item.value #>> '{}', 'UTF8'), utf8_byte.byte_index) >= 240) > 160
      END)
    END`
}

function sqlIntegerInRange(snapshot: string, key: "minScore" | "dailyCap", minimum: number, maximum: number): string {
  const value = `(${snapshot}->'${key}')`, exact = `(${snapshot}->>'${key}')::numeric`
  const number = `(${snapshot}->>'${key}')::double precision`
  // Exact coarse bounds safely enclose accepted float8 rounding while avoiding casts of huge JSON numbers.
  const coarseMinimum = minimum === 0 ? -1 : 0, coarseMaximum = maximum + 1
  return `CASE WHEN jsonb_typeof(${value}) IS DISTINCT FROM 'number' THEN FALSE
    WHEN ${exact} NOT BETWEEN ${coarseMinimum} AND ${coarseMaximum} THEN FALSE
    ELSE ${number} BETWEEN ${minimum} AND ${maximum} AND trunc(${number}) = ${number} END`
}

function sqlNormalizedArray(snapshot: string, key: "targetRoles" | "targetLocations"): string {
  return `COALESCE((SELECT jsonb_agg(btrim(item.value #>> '{}', ${SQL_TRIM_CHARACTERS}) ORDER BY item.ordinality)
    FROM jsonb_array_elements(${snapshot}->'${key}') WITH ORDINALITY AS item(value, ordinality)), '[]'::jsonb)`
}

/** SQL prefilter for the 64-row window; returned rows are still revalidated in TypeScript. */
export function scheduledAutomationHistoryCompatibilitySql(currentCriteriaParameter: string): string {
  const input = 'turn."input"', source = 'turn."source"'
  const snapshot = `(${input}->'scheduledAutomationSnapshot')`
  const schemaVersionJson = `'${JSON.stringify(SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION)}'::jsonb`
  const scheduled = `COALESCE((${source} = 'automation' AND ${input}->>'automationRunMode' = 'scheduled'), FALSE)`
  const validSnapshot = `CASE
    WHEN jsonb_typeof(${input}) IS DISTINCT FROM 'object' THEN FALSE
    WHEN jsonb_typeof(${snapshot}) IS DISTINCT FROM 'object' THEN FALSE
    WHEN (${snapshot} - ${SQL_SNAPSHOT_KEYS}) <> '{}'::jsonb THEN FALSE
    WHEN NOT (${snapshot} ?& ${SQL_SNAPSHOT_KEYS}) THEN FALSE
    WHEN ${snapshot}->'schemaVersion' IS DISTINCT FROM ${schemaVersionJson} THEN FALSE
    WHEN NOT (${sqlArrayValid(snapshot, "targetRoles", 1)}) THEN FALSE
    WHEN NOT (${sqlArrayValid(snapshot, "targetLocations", 0)}) THEN FALSE
    WHEN NOT (${sqlIntegerInRange(snapshot, "minScore", 0, 100)}) THEN FALSE
    WHEN NOT (${sqlIntegerInRange(snapshot, "dailyCap", 1, 50)}) THEN FALSE
    WHEN jsonb_typeof(${snapshot}->'requireApproval') IS DISTINCT FROM 'boolean' THEN FALSE
    WHEN jsonb_typeof(${snapshot}->'autoApply') IS DISTINCT FROM 'boolean' THEN FALSE
    ELSE TRUE END`
  const criteria = `jsonb_build_object('targetRoles', ${sqlNormalizedArray(snapshot, "targetRoles")},
    'targetLocations', ${sqlNormalizedArray(snapshot, "targetLocations")},
    'minScore', to_jsonb((${snapshot}->>'minScore')::double precision))`
  return `CASE WHEN ${currentCriteriaParameter}::jsonb IS NULL THEN NOT ${scheduled}
    ELSE ${scheduled} AND CASE WHEN ${validSnapshot} THEN ${criteria} = ${currentCriteriaParameter}::jsonb ELSE FALSE END END`
}
