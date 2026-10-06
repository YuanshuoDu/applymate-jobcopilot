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
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ADDITIONAL_CRITERIA
    || Reflect.ownKeys(value).length !== value.length + 1) return null
  const criteria: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") return null
    const item = value[index]!.trim()
    if (!item || Buffer.byteLength(item, "utf8") > MAX_ADDITIONAL_CRITERION_BYTES) return null
    if (!criteria.includes(item)) criteria.push(item)
  }
  return criteria
}

/** Parses the server-owned JSONB checklist, including the empty legacy value. */
export function parsePersistedRootCriteria(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ROOT_CRITERIA || Reflect.ownKeys(value).length !== value.length + 1) return null
  const criteria: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (!Object.hasOwn(value, index) || typeof item !== "string" || !item || item.trim() !== item
      || Buffer.byteLength(item, "utf8") > MAX_ROOT_CRITERION_BYTES || criteria.includes(item)) return null
    criteria.push(item)
  }
  return criteria
}

export function parsePinnedRootCriteria(value: unknown): readonly string[] | null {
  const criteria = parsePersistedRootCriteria(value)
  return !criteria || criteria.length < 1 || criteria.length > MAX_ADDITIONAL_CRITERIA + 1
    || criteria.slice(1).some(item => Buffer.byteLength(item, "utf8") > MAX_ADDITIONAL_CRITERION_BYTES) ? null : criteria
}

export function readRootPlanCriteriaObservation(state: Record<string, unknown>): readonly string[] | undefined {
  if (!Object.hasOwn(state, "rootSuccessCriteria")) return undefined
  const criteria = parsePersistedRootCriteria(state.rootSuccessCriteria)
  if (!criteria) throw new Error("task_graph_current_state_invalid:rootSuccessCriteria")
  return criteria
}

/** Pins the immutable server goal before model-authored additional requirements. */
export function resolveRootPlanCriteria(goal: unknown, currentValue: unknown, additional: readonly string[]): RootPlanCriteriaResolution {
  if (typeof goal !== "string" || !goal.trim() || goal.trim() !== goal
    || Buffer.byteLength(goal, "utf8") > MAX_ROOT_CRITERION_BYTES) return { status: "invalid" }
  const current = parsePersistedRootCriteria(currentValue)
  if (!current) return { status: "invalid" }
  const criteria = [...new Set([goal, ...additional])]
  if (criteria.length > MAX_ROOT_CRITERIA || criteria.some(item => Buffer.byteLength(item, "utf8") > MAX_ROOT_CRITERION_BYTES)) return { status: "invalid" }
  if (current.length === 0) return { status: "persist", criteria }
  return current.length === criteria.length && current.every((item, index) => item === criteria[index])
    ? { status: "unchanged", criteria }
    : { status: "conflict" }
}
