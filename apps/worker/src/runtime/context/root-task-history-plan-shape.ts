import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"

export type RootTaskHistoryPlanRole = "scout" | "analyst" | "writer" | "reviewer" | "other"
export type RootTaskHistoryPlanShape = Readonly<{
  schemaVersion: "agent-harness.v2.root-task-history-plan-shape.v1"
  ordinalScope: "source_graph_local"
  advisoryOnly: true
  notCurrentEvidence: true
  nodes: readonly Readonly<{ ordinal: number; role: RootTaskHistoryPlanRole; dependsOnOrdinals: readonly number[] }>[]
}>
type Row = Record<string, unknown>
const ROLES = new Set<RootTaskHistoryPlanRole>(["scout", "analyst", "writer", "reviewer", "other"])
const TEMPLATES = new Map<string, RootTaskHistoryPlanRole>([
  ["scout", "scout"], ["analyst", "analyst"], ["cover_letter_writer", "writer"], ["cover_letter_reviewer", "reviewer"],
])

function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Row : undefined
  } catch { return undefined }
}
function data(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}
function exact(value: Row, keys: readonly string[]): boolean {
  try {
    const own = Reflect.ownKeys(value)
    return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key))
  } catch { return false }
}
function denseValues(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value
    const keys = Reflect.ownKeys(value)
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum || keys.length !== Number(length) + 1
      || keys.some(key => typeof key !== "string")) return undefined
    const result: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined
        result.push(descriptor.value)
    }
    return result
  } catch { return undefined }
}
function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= TASK_GRAPH_LIMITS.maxKeyLength && value.trim() === value
}
function validOrdinals(value: unknown, count: number): number[] | undefined {
  const ordinals = denseValues(value, count)
  if (!ordinals || ordinals.length !== count) return undefined
  return ordinals.every((ordinal, index) => typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= count
    && ordinals.indexOf(ordinal) === index) ? ordinals.map(Number) : undefined
}
function acyclic(nodes: readonly Readonly<{ ordinal: number; dependsOnOrdinals: readonly number[] }>[]): boolean {
  const byOrdinal = new Map(nodes.map(node => [node.ordinal, node.dependsOnOrdinals] as const)), visiting = new Set<number>(), visited = new Set<number>()
  const visit = (ordinal: number): boolean => {
    if (visiting.has(ordinal)) return false
    if (visited.has(ordinal)) return true
    visiting.add(ordinal)
    for (const dependency of byOrdinal.get(ordinal) ?? []) if (!visit(dependency)) return false
    visiting.delete(ordinal); visited.add(ordinal)
    return true
  }
  return nodes.every(node => visit(node.ordinal))
}

/** Parses only the closed model-facing topology packet; all identifiers are source-local ordinals. */
export function parseRootTaskHistoryPlanShape(value: unknown): RootTaskHistoryPlanShape | undefined {
  const packet = record(value)
  const rawNodes = packet && data(packet, "nodes")
  const sourceNodes = denseValues(rawNodes, TASK_GRAPH_LIMITS.maxNodes)
  if (!packet || !exact(packet, ["schemaVersion", "ordinalScope", "advisoryOnly", "notCurrentEvidence", "nodes"])
    || data(packet, "schemaVersion") !== "agent-harness.v2.root-task-history-plan-shape.v1"
    || data(packet, "ordinalScope") !== "source_graph_local" || data(packet, "advisoryOnly") !== true
    || data(packet, "notCurrentEvidence") !== true || !sourceNodes || sourceNodes.length < 1) return undefined
  const nodes: Array<{ ordinal: number; role: RootTaskHistoryPlanRole; dependsOnOrdinals: number[] }> = []
  for (let index = 0; index < sourceNodes.length; index++) {
    const node = record(sourceNodes[index]), ordinal = node && data(node, "ordinal"), role = node && data(node, "role")
    const rawDependencies = node && data(node, "dependsOnOrdinals")
    const dependencies = denseValues(rawDependencies, TASK_GRAPH_LIMITS.maxNodes)
    if (!node || !exact(node, ["ordinal", "role", "dependsOnOrdinals"]) || ordinal !== index + 1
      || typeof role !== "string" || !ROLES.has(role as RootTaskHistoryPlanRole) || !dependencies) return undefined
    const deps = dependencies
    if (deps.some((dependency, depIndex) => !Number.isSafeInteger(dependency) || Number(dependency) < 1
      || Number(dependency) > sourceNodes.length || Number(dependency) === ordinal
      || deps.indexOf(dependency) !== depIndex || depIndex > 0 && Number(deps[depIndex - 1]) >= Number(dependency))) return undefined
    nodes.push({ ordinal: Number(ordinal), role: role as RootTaskHistoryPlanRole, dependsOnOrdinals: deps.map(Number) })
  }
  if (!acyclic(nodes)) return undefined
  return { schemaVersion: "agent-harness.v2.root-task-history-plan-shape.v1", ordinalScope: "source_graph_local",
    advisoryOnly: true, notCurrentEvidence: true, nodes }
}

/** Builds a complete sanitized skeleton from the validated graph before its outcome nodes are sorted. */
export function buildRootTaskHistoryPlanShape(graph: unknown, sourceNodeOrdinals: unknown): RootTaskHistoryPlanShape | undefined {
  const graphRow = record(graph), rawNodes = graphRow && data(graphRow, "nodes")
  const graphNodes = denseValues(rawNodes, TASK_GRAPH_LIMITS.maxNodes)
  if (!graphNodes || graphNodes.length < 1) return undefined
  const ordinals = validOrdinals(sourceNodeOrdinals, graphNodes.length)
  if (!ordinals) return undefined
  const keyOrdinals = new Map<string, number>(), source: Array<{ key: string; role: RootTaskHistoryPlanRole; dependencies: string[] }> = []
  for (let index = 0; index < graphNodes.length; index++) {
    const node = record(graphNodes[index]), key = node && data(node, "key"), template = node && data(node, "templateId")
    const dependencies = node && denseValues(data(node, "dependsOn"), TASK_GRAPH_LIMITS.maxDependencies)
    if (!node || !validKey(key) || keyOrdinals.has(key) || typeof template !== "string" || template.length < 1
      || template.length > TASK_GRAPH_LIMITS.maxTemplateIdLength || template.trim() !== template || !dependencies
      || dependencies.some(dependency => !validKey(dependency))) return undefined
    keyOrdinals.set(key, ordinals[index]!)
    source.push({ key, role: TEMPLATES.get(template) ?? "other", dependencies: dependencies as string[] })
  }
  const nodes = source.map((node, index) => {
    const dependencies = node.dependencies.map(key => keyOrdinals.get(key))
    if (dependencies.some(ordinal => ordinal === undefined || ordinal === ordinals[index])) return undefined
    const deps = (dependencies as number[]).sort((left, right) => left - right)
    if (new Set(deps).size !== deps.length) return undefined
    return { ordinal: ordinals[index]!, role: node.role, dependsOnOrdinals: deps }
  }).sort((left, right) => (left?.ordinal ?? 0) - (right?.ordinal ?? 0))
  if (nodes.some(node => node === undefined)) return undefined
  const packet = { schemaVersion: "agent-harness.v2.root-task-history-plan-shape.v1", ordinalScope: "source_graph_local",
    advisoryOnly: true, notCurrentEvidence: true, nodes }
  return parseRootTaskHistoryPlanShape(packet)
}
