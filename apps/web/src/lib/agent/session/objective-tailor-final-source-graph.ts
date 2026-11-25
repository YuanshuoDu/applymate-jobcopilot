import { parseTaskGraphSnapshot, type TaskGraphSnapshot } from '@jobcopilot/agent-protocol'
import { parseObjectiveTailorFinalOutcomesFromContent } from './objective-tailor-final-content'
import { parseObjectiveTailorProgressSnapshot } from './objective-tailor-progress-snapshot'

const MAX_ORDINARY_TASK_GRAPH_NODES = 11

export type FinalTaskGraphSourceSnapshot = Readonly<{
  kind: 'ordinary' | 'objective-tailor'
  snapshot: TaskGraphSnapshot
  graph: unknown
}>

/** Reads the bounded source view for the exact final graph; callers own identity and proof checks. */
export function readFinalTaskGraphSourceSnapshot(
  graphContent: unknown, finalContent: unknown,
): FinalTaskGraphSourceSnapshot | null {
  const inspected = inspectGraph(graphContent)
  if (!inspected) return null
  if (!inspected.marked) {
    const snapshot = parseTaskGraphSnapshot(graphContent)
    return snapshot && snapshot.nodes.length >= 1 && snapshot.nodes.length <= MAX_ORDINARY_TASK_GRAPH_NODES
      ? { kind: 'ordinary', snapshot, graph: graphContent } : null
  }

  const progress = parseObjectiveTailorProgressSnapshot(inspected.value)
  const sidecar = parseObjectiveTailorFinalOutcomesFromContent(finalContent)
  if (!progress || !sidecar || sidecar.slots.length !== progress.marker.slots.length) return null
  const graph = sourcePrefix(inspected.value, progress.marker.sourceNodeCount)
  const snapshot = graph && parseTaskGraphSnapshot(graph)
  if (!snapshot || snapshot.nodes.length !== progress.marker.sourceNodeCount
    || snapshot.nodes.some((node, index) => {
      const expected = progress.nodes[index]
      return !expected || node.key !== expected.key || node.taskId !== expected.taskId || node.templateId !== expected.templateId
    })) return null
  return { kind: 'objective-tailor', snapshot, graph }
}

function inspectGraph(value: unknown): { value: unknown; marked: boolean } | null {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown } catch { return { value, marked: false } }
  }
  if (!parsed || typeof parsed !== 'object') return { value: parsed, marked: false }
  try { return { value: parsed, marked: Object.hasOwn(parsed, 'objectiveTailor') } } catch { return null }
}

function sourcePrefix(value: unknown, count: number): Record<string, unknown> | null {
  const row = plainRecord(value)
  if (!row) return null
  const schema = ownValue(row, 'schemaVersion'), rawNodes = ownValue(row, 'nodes')
  if (!schema.ok || !rawNodes.ok || !Array.isArray(rawNodes.value)
    || !Number.isSafeInteger(count) || count < 1) return null
  const nodes = rawNodes.value
  let keys: readonly PropertyKey[], length: number, prototype: object | null
  try {
    keys = Reflect.ownKeys(nodes); length = nodes.length; prototype = Object.getPrototypeOf(nodes)
  } catch { return null }
  if (prototype !== Array.prototype || length < count || keys.length !== length + 1
    || keys.some(key => typeof key !== 'string')) return null
  const prefix: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownValue(nodes, String(index))
    if (!descriptor.ok) return null
    if (index < count) prefix.push(descriptor.value)
  }
  return { schemaVersion: schema.value, nodes: prefix }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    if (keys.some(key => typeof key !== 'string' || !ownValue(value, key).ok)) return null
    return value as Record<string, unknown>
  } catch { return null }
}

function ownValue(value: object, key: PropertyKey): { ok: true; value: unknown } | { ok: false } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
      ? { ok: true, value: descriptor.value } : { ok: false }
  } catch { return { ok: false } }
}
