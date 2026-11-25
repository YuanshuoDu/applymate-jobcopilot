import { TASK_GRAPH_MAX_IDENTIFIER_LENGTH } from "./plan-ledger.js"

export const OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION = "agent-harness.v2.objective-tailor-graph.v1" as const
export const OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION = "agent-harness.v2.objective-tailor-graph.v2" as const
export const OBJECTIVE_TAILOR_GRAPH_MAX_NODES = 40 as const

type SlotNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
type SlotId = `tailor-${SlotNumber}`
type Correction = Readonly<{ writerNodeKey: string; reviewerNodeKey: string }>
type Slot = Readonly<{
  slotId: SlotId
  sourceAnalystNodeKey: string
  writerNodeKey: string
  reviewerNodeKey: string
  correction?: Correction
}>

type ObjectiveTailorGraphBase = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION
  sourceNodeCount: number
  slots: readonly Slot[]
}>
export type ObjectiveTailorGraph = ObjectiveTailorGraphBase | Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION
  sourceNodeCount: number
  reportScoreFloor: number
  slots: readonly Slot[]
}>

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== "string")) return null
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === expected.length && actual.every(key => typeof key === "string")
    && [...actual].sort().join(",") === [...expected].sort().join(",")
}

function denseValues(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== "string") || !keys.includes("length")) return null
  const keySet = new Set(keys as string[])
  const result: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const key = String(index), descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!keySet.has(key) || !descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
    result.push(descriptor.value)
  }
  return Object.hasOwn(value, "length") ? result : null
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= TASK_GRAPH_MAX_IDENTIFIER_LENGTH
}

function dependencies(value: unknown, expected: string): boolean {
  const rows = denseValues(value, 1)
  return rows?.length === 1 && rows[0] === expected
}

/** Validates the closed public extension against the exact ordered TaskGraph nodes. */
export function parseObjectiveTailorGraph(marker: unknown, nodes: unknown): ObjectiveTailorGraph | null {
  try { return parseObjectiveTailorGraphInner(marker, nodes) } catch { return null }
}

function parseObjectiveTailorGraphInner(marker: unknown, nodes: unknown): ObjectiveTailorGraph | null {
  const envelope = record(marker), nodeRows = denseValues(nodes, OBJECTIVE_TAILOR_GRAPH_MAX_NODES)
  const version = envelope?.schemaVersion
  const hasFloor = version === OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION
  if (!envelope || !exactKeys(envelope, hasFloor
    ? ["schemaVersion", "sourceNodeCount", "reportScoreFloor", "slots"]
    : ["schemaVersion", "sourceNodeCount", "slots"])
    || version !== OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION && !hasFloor || !nodeRows) return null
  const reportScoreFloor = envelope.reportScoreFloor
  if (hasFloor && (typeof reportScoreFloor !== "number" || !Number.isFinite(reportScoreFloor)
    || reportScoreFloor < 0 || reportScoreFloor > 10)) return null
  const sourceNodeCount = envelope.sourceNodeCount
  if (typeof sourceNodeCount !== "number" || !Number.isSafeInteger(sourceNodeCount) || sourceNodeCount < 2 || sourceNodeCount > 8) return null
  const sourceCount = sourceNodeCount
  const slotRows = denseValues(envelope.slots, 8)
  if (!slotRows || slotRows.length < 1) return null
  const parsedNodes: Record<string, unknown>[] = [], byKey = new Map<string, { node: Record<string, unknown>; index: number }>()
  for (const raw of nodeRows) {
    const node = record(raw)
    if (!node || !identifier(node.key) || !identifier(node.templateId) || byKey.has(node.key)) return null
    const index = parsedNodes.length
    parsedNodes.push(node); byKey.set(node.key, { node, index })
  }
  if (parsedNodes.length > OBJECTIVE_TAILOR_GRAPH_MAX_NODES || sourceCount >= parsedNodes.length) return null
  const sourceKeys = new Set(parsedNodes.slice(0, sourceCount).map(node => node.key as string))
  for (const node of parsedNodes.slice(0, sourceCount)) {
    const sourceDependencies = denseValues(node.dependsOn, 8)
    if ((node.templateId !== "scout" && node.templateId !== "analyst") || node.verificationDisposition !== "typed"
      || !sourceDependencies || sourceDependencies.some(dependency => !identifier(dependency) || !sourceKeys.has(dependency))) return null
  }
  const suffixKeys = new Set(parsedNodes.slice(sourceCount).map(node => node.key as string))
  const claimed = new Set<string>(), slots: Slot[] = []
  const claim = (key: unknown, templateId: string, dependency: string, afterIndex: number): number | null => {
    if (!identifier(key) || !suffixKeys.has(key) || claimed.has(key)) return null
    const found = byKey.get(key)
    if (!found || found.node.templateId !== templateId || found.index <= afterIndex
      || !dependencies(found.node.dependsOn, dependency)) return null
    claimed.add(key)
    return found.index
  }
  for (const [index, raw] of slotRows.entries()) {
    const row = record(raw), hasCorrection = Boolean(row && Object.hasOwn(row, "correction"))
    if (!row || !exactKeys(row, hasCorrection
      ? ["slotId", "sourceAnalystNodeKey", "writerNodeKey", "reviewerNodeKey", "correction"]
      : ["slotId", "sourceAnalystNodeKey", "writerNodeKey", "reviewerNodeKey"])
      || row.slotId !== `tailor-${index + 1}` || !identifier(row.sourceAnalystNodeKey)) return null
    const source = byKey.get(row.sourceAnalystNodeKey)
    if (!source || source.index >= Number(sourceNodeCount) || source.node.templateId !== "analyst"
      || source.node.verificationDisposition !== "typed") return null
    const writerIndex = claim(row.writerNodeKey, "cover_letter_writer", row.sourceAnalystNodeKey, sourceCount - 1)
    if (writerIndex === null) return null
    const reviewerIndex = claim(row.reviewerNodeKey, "cover_letter_reviewer", row.writerNodeKey as string, writerIndex)
    if (reviewerIndex === null) return null
    let correction: Correction | undefined
    if (hasCorrection) {
      const repair = record(row.correction)
      if (!repair || !exactKeys(repair, ["writerNodeKey", "reviewerNodeKey"])) return null
      const repairWriterIndex = claim(repair.writerNodeKey, "cover_letter_writer", row.reviewerNodeKey as string, reviewerIndex)
      if (repairWriterIndex === null
        || claim(repair.reviewerNodeKey, "cover_letter_reviewer", repair.writerNodeKey as string, repairWriterIndex) === null) return null
      correction = { writerNodeKey: repair.writerNodeKey as string, reviewerNodeKey: repair.reviewerNodeKey as string }
    }
    slots.push({ slotId: row.slotId as SlotId, sourceAnalystNodeKey: row.sourceAnalystNodeKey,
      writerNodeKey: row.writerNodeKey as string, reviewerNodeKey: row.reviewerNodeKey as string,
      ...(correction ? { correction } : {}) })
  }
  if (claimed.size !== suffixKeys.size) return null
  return hasFloor
    ? { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCORE_FLOOR_SCHEMA_VERSION, sourceNodeCount: sourceCount,
      reportScoreFloor: reportScoreFloor as number, slots }
    : { schemaVersion: OBJECTIVE_TAILOR_GRAPH_SCHEMA_VERSION, sourceNodeCount: sourceCount, slots }
}
