import { parsePersistedTaskGraphNode } from './plan-ledger-task-graph-metadata.js'
import { isStrictNativeTaskGraphNode } from './plan-ledger-native-metadata.js'
import type { TaskGraphSnapshotNode } from './plan-ledger.js'

export const PLAN_LEDGER_MAX_PERSISTED_NODES = 11
export const PLAN_LEDGER_MAX_SNAPSHOT_BYTES = 40_000
const MAX_PACKAGE_REFS = 50, MAX_DEPTH = 8, MAX_SUCCESS_CRITERIA = 8, MAX_DEPENDENCIES = 8
const MAX_GOAL_LENGTH = 1_200, MAX_CRITERION_LENGTH = 320
const SCHEDULED_SPECIALIZED_TEMPLATES = new Set([
  'prepare', 'gate', 'scheduled_audit', 'scheduled.application.execute', 'scheduled.post_gate_audit',
])
const EXECUTE_TEMPLATE = 'scheduled.application.execute'
const SPECIALIZED_KEYS = 'dependsOn,depth,goal,key,successCriteria,taskId,templateId,verificationDisposition'
const EXECUTE_KEYS = 'dependsOn,depth,goal,key,packageRefs,successCriteria,taskId,templateId,verificationDisposition'

/** Parses bounded stored nodes, validating private package partitions before metadata is stripped. */
export function parsePlanLedgerTaskGraphSnapshotNodes(value: unknown): TaskGraphSnapshotNode[] | null {
  try { return parseTaskGraphSnapshotNodes(value) } catch { return null }
}

function parseTaskGraphSnapshotNodes(value: unknown): TaskGraphSnapshotNode[] | null {
  if (!strictDense(value, PLAN_LEDGER_MAX_PERSISTED_NODES)) return null
  const nodes: TaskGraphSnapshotNode[] = [], keys = new Set<string>(), ids = new Set<string>(), packageRefs: string[] = []
  const executePartitions: string[][] = []
  for (const raw of value) {
    const normalized = normalizeScheduledNode(raw)
    if (!normalized) return null
    const native = isStrictNativeTaskGraphNode(raw), node = parsePersistedTaskGraphNode(normalized.value)
    const goalLength = native ? 4_000 : MAX_GOAL_LENGTH, criteriaCount = native ? 32 : MAX_SUCCESS_CRITERIA
    const criterionLength = native ? 1_000 : MAX_CRITERION_LENGTH
    if (!node || !text(node.key, 128) || !text(node.templateId, 128) || !text(node.goal, goalLength)
      || !text(node.taskId, 128) || !strictDense(node.successCriteria, criteriaCount) || node.successCriteria.length === 0 && !native
      || !node.successCriteria.every(item => text(item, criterionLength)) || !strictDense(node.dependsOn, MAX_DEPENDENCIES)
      || !node.dependsOn.every(item => text(item, 128)) || new Set(node.dependsOn).size !== node.dependsOn.length
      || !Number.isSafeInteger(node.depth) || Number(node.depth) < 1 || Number(node.depth) > MAX_DEPTH
      || keys.has(node.key) || ids.has(node.taskId)) return null
    keys.add(node.key); ids.add(node.taskId)
    if (normalized.packageRefs) {
      executePartitions.push(normalized.packageRefs)
      packageRefs.push(...normalized.packageRefs)
    }
    nodes.push({ ...node, successCriteria: [...node.successCriteria], dependsOn: [...node.dependsOn], depth: Number(node.depth) })
  }
  if (executePartitions.length > 3 || executePartitions.length > 1 && executePartitions.some(refs => refs.length === 0)
    || packageRefs.length > MAX_PACKAGE_REFS || new Set(packageRefs).size !== packageRefs.length
    || nodes.some(node => node.dependsOn.some(key => !keys.has(key))) || !acyclic(nodes)) return null
  return nodes
}

function normalizeScheduledNode(value: unknown): Readonly<{ value: unknown; packageRefs?: string[] }> | null {
  if (!record(value)) return null
  const templateId = value.templateId
  if (typeof templateId !== 'string' || !SCHEDULED_SPECIALIZED_TEMPLATES.has(templateId)) {
    return Object.hasOwn(value, 'packageRefs') ? null : { value }
  }
  if (value.verificationDisposition !== 'specialized' || Object.hasOwn(value, 'verification') || Object.hasOwn(value, 'repairOf')) return null
  if (templateId === EXECUTE_TEMPLATE) {
    if (!exact(value, EXECUTE_KEYS) || !validPackageRefs(value.packageRefs)) return null
    const packageRefs = [...value.packageRefs as string[]]
    const { verificationDisposition: _disposition, packageRefs: _refs, ...normalized } = value
    return { value: normalized, packageRefs }
  }
  if (!exact(value, SPECIALIZED_KEYS) || Object.hasOwn(value, 'packageRefs')) return null
  const { verificationDisposition: _disposition, ...normalized } = value
  return { value: normalized }
}

function validPackageRefs(value: unknown): value is string[] {
  return strictDense(value, MAX_PACKAGE_REFS) && value.every(ref => text(ref, 256) && ref.trim() === ref
    && !/[\u0000-\u001f\u007f]/.test(ref)) && new Set(value).size === value.length
}
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    return (prototype === Object.prototype || prototype === null) && keys.every(key => typeof key === 'string'
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && 'value' in Object.getOwnPropertyDescriptor(value, key)!)
  } catch { return false }
}
function exact(value: Record<string, unknown>, keys: string): boolean {
  return Reflect.ownKeys(value).sort().join(',') === keys
}
function strictDense(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(value, key))
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}
function acyclic(nodes: readonly { key: string; dependsOn: readonly string[] }[]): boolean {
  const visited = new Set<string>(), active = new Set<string>(), byKey = new Map(nodes.map(node => [node.key, node] as const))
  const visit = (key: string): boolean => {
    if (active.has(key)) return false
    if (visited.has(key)) return true
    active.add(key)
    for (const dependency of byKey.get(key)?.dependsOn ?? []) if (!visit(dependency)) return false
    active.delete(key); visited.add(key); return true
  }
  return nodes.every(node => visit(node.key))
}
