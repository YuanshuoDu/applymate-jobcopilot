import {
  taskGraphInputRelation,
  type TaskGraphInputRelation,
  type TaskGraphSourceCheckpoint,
  type TaskGraphSourceIntent,
} from "./task-graph-pg-source-provenance.js"

const INPUT_RELATIONS = new Set([
  "predates_current_inputs", "covers_current_inputs", "unknown",
])
const NODE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_SOURCE_INTENTS = 16
const MAX_GOAL_LENGTH = 1200
const MAX_SUCCESS_CRITERIA = 8
const MAX_CRITERION_LENGTH = 320

export type TaskGraphRootSourceIntent = TaskGraphSourceIntent & Readonly<{ nodeKey: string }>

/** Builds advisory intent for one exact dependency without exposing checkpoint data. */
export function sourceIntentForTaskGraphNode(
  node: Readonly<{ goal: unknown; successCriteria: unknown }>,
  sourceCheckpoint?: TaskGraphSourceCheckpoint | null,
  currentCheckpoint?: TaskGraphSourceCheckpoint | null,
): TaskGraphSourceIntent | undefined {
  return projectTaskGraphDependencySourceIntent({
    goal: node.goal,
    successCriteria: node.successCriteria,
    inputRelation: taskGraphInputRelation(sourceCheckpoint, currentCheckpoint),
  })
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

function dataValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  try {
    const keys = Reflect.ownKeys(value)
    return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
  } catch { return false }
}

function denseDataArray(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== "length"
      && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return undefined
    const items: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !("value" in descriptor)) return undefined
      items.push(descriptor.value)
    }
    return items
  } catch { return undefined }
}

/** Projects only the bounded intent metadata safe for a direct Analyst dependency. */
export function projectTaskGraphDependencySourceIntent(value: unknown): TaskGraphSourceIntent | undefined {
  const row = plainRecord(value)
  if (!row || !exactKeys(row, "goal,inputRelation,successCriteria")) return undefined
  const goal = dataValue(row, "goal")
  const successCriteria = denseDataArray(dataValue(row, "successCriteria"), MAX_SUCCESS_CRITERIA)
  const inputRelation = dataValue(row, "inputRelation")
  if (typeof goal !== "string" || !goal.trim() || goal.length > MAX_GOAL_LENGTH
    || !successCriteria
    || successCriteria.some(item => typeof item !== "string" || !item.trim() || item.length > MAX_CRITERION_LENGTH)
    || typeof inputRelation !== "string" || !INPUT_RELATIONS.has(inputRelation)) return undefined
  return { goal, successCriteria: successCriteria as string[], inputRelation: inputRelation as TaskGraphInputRelation }
}

/** Projects bounded Root metadata, tied to the exact current graph node keys. */
export function projectTaskGraphRootSourceIntents(
  value: unknown,
  currentNodeKeys: ReadonlySet<string>,
): readonly TaskGraphRootSourceIntent[] {
  const items = denseDataArray(value, MAX_SOURCE_INTENTS)
  if (!items) return []
  const result: TaskGraphRootSourceIntent[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const row = plainRecord(item)
    if (!row || !exactKeys(row, "goal,inputRelation,nodeKey,successCriteria")) continue
    const nodeKey = dataValue(row, "nodeKey")
    if (typeof nodeKey !== "string" || !NODE_KEY.test(nodeKey) || !currentNodeKeys.has(nodeKey) || seen.has(nodeKey)) continue
    const intent = projectTaskGraphDependencySourceIntent({
      goal: dataValue(row, "goal"),
      successCriteria: dataValue(row, "successCriteria"),
      inputRelation: dataValue(row, "inputRelation"),
    })
    if (!intent) continue
    seen.add(nodeKey)
    result.push({ nodeKey, ...intent })
  }
  return result
}

/** Adds optional source intent only when the existing Root observation still fits its byte budget. */
export function withTaskGraphRootSourceIntent<T extends Record<string, unknown>>(
  base: T,
  value: unknown,
  maxChars: number,
): T | (T & Readonly<{ sourceIntent: readonly TaskGraphRootSourceIntent[] }>) {
  const nodes = dataValue(base, "nodes")
  if (!Array.isArray(nodes)) return base
  const keys = new Set<string>()
  for (const item of nodes) {
    const row = plainRecord(item)
    const key = row ? dataValue(row, "key") : undefined
    if (typeof key === "string") keys.add(key)
  }
  const sourceIntent = projectTaskGraphRootSourceIntents(value, keys)
  if (!sourceIntent.length) return base
  const candidate = { ...base, sourceIntent }
  try {
    const encoded = JSON.stringify(candidate)
    return encoded && encoded.length <= maxChars ? candidate : base
  } catch { return base }
}
