import { Buffer } from "node:buffer"

const MAX_ADDITIONAL_CRITERIA = 4
const MAX_ADDITIONAL_CRITERION_BYTES = 512
const MAX_ROOT_CRITERIA = 32
const MAX_ROOT_CRITERION_BYTES = 2_000

export type RootPlanCriteriaResolution = Readonly<{
  status: "unchanged" | "persist" | "conflict" | "invalid"
  criteria?: readonly string[]
}>

/** Normalizes only outer whitespace; the accepted wording remains otherwise unchanged. */
export function normalizeRootPlanCriteria(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  const items = ownDataArray(value, MAX_ADDITIONAL_CRITERIA)
  if (!items?.length) return null
  const criteria: string[] = []
  for (const raw of items) {
    if (typeof raw !== "string") return null
    const item = raw.trim()
    if (!item || Buffer.byteLength(item, "utf8") > MAX_ADDITIONAL_CRITERION_BYTES) return null
    if (!criteria.includes(item)) criteria.push(item)
  }
  return criteria
}

/** Parses the server-owned JSONB checklist, including the empty legacy value. */
export function parsePersistedRootCriteria(value: unknown): readonly string[] | null {
  const items = ownDataArray(value, MAX_ROOT_CRITERIA)
  if (!items) return null
  const criteria: string[] = []
  for (const item of items) {
    if (typeof item !== "string" || !item || item.trim() !== item
      || Buffer.byteLength(item, "utf8") > MAX_ROOT_CRITERION_BYTES || criteria.includes(item)) return null
    criteria.push(item)
  }
  return criteria
}

function ownDataArray(value: unknown, maximum: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) return null
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
    const items: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const item = descriptors[String(index)]
      if (!item || !("value" in item) || !item.enumerable) return null
      items.push(item.value)
    }
    return items
  } catch { return null }
}
export function parsePinnedRootCriteria(value: unknown): readonly string[] | null {
  const criteria = parsePersistedRootCriteria(value)
  return !criteria || criteria.length < 1 || criteria.length > MAX_ADDITIONAL_CRITERIA + 1
    || criteria.slice(1).some(item => Buffer.byteLength(item, "utf8") > MAX_ADDITIONAL_CRITERION_BYTES) ? null : criteria
}

export function readRootPlanCriteriaObservation(state: Record<string, unknown>): readonly string[] | undefined {
  return readRootCriteriaProperty(state, parsePersistedRootCriteria, "task_graph_current_state_invalid:rootSuccessCriteria")
}

export function readPinnedRootCriteria(state: Record<string, unknown>): readonly string[] | undefined {
  return readRootCriteriaProperty(state, parsePinnedRootCriteria, "task_graph_snapshot_root_criteria_invalid")
}

function readRootCriteriaProperty(
  state: Record<string, unknown>, parse: (value: unknown) => readonly string[] | null, errorCode: string,
): readonly string[] | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(state, "rootSuccessCriteria")
    if (!descriptor) return undefined
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(errorCode)
    const criteria = parse(descriptor.value)
    if (!criteria) throw new Error(errorCode)
    return criteria
  } catch { throw new Error(errorCode) }
}

/** Pins the immutable server goal before model-authored additional requirements. */
export function resolveRootPlanCriteria(
  goal: unknown, currentValue: unknown, additional: readonly string[], ownedCriteriaValue: unknown = [],
): RootPlanCriteriaResolution {
  if (typeof goal !== "string" || !goal.trim() || goal.trim() !== goal
    || Buffer.byteLength(goal, "utf8") > MAX_ROOT_CRITERION_BYTES) return { status: "invalid" }
  const current = parsePersistedRootCriteria(currentValue)
  const ownedCriteria = parsePersistedRootCriteria(ownedCriteriaValue)
  if (!current || !ownedCriteria) return { status: "invalid" }
  const pinnedAdditional = current.length ? current.slice(1) : additional
  const verifierCriteria = [...new Set([goal, ...ownedCriteria, ...pinnedAdditional])]
  if (verifierCriteria.length > MAX_ROOT_CRITERIA
    || verifierCriteria.some(item => Buffer.byteLength(item, "utf8") > MAX_ROOT_CRITERION_BYTES)) return { status: "invalid" }
  const criteria = [...new Set([goal, ...additional])]
  if (criteria.length > MAX_ROOT_CRITERIA || criteria.some(item => Buffer.byteLength(item, "utf8") > MAX_ROOT_CRITERION_BYTES)) return { status: "invalid" }
  if (current.length === 0) return { status: "persist", criteria }
  return current.length === criteria.length && current.every((item, index) => item === criteria[index])
    ? { status: "unchanged", criteria }
    : { status: "conflict" }
}
