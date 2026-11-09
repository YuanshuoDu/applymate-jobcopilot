import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { projectScheduledPipelineGraphAtCurrentStage } from "./scheduled-pipeline-graph-shape.js"

const PACKAGE_REFS_NODE_KEYS = "dependsOn,depth,goal,key,packageRefs,successCriteria,taskId,templateId,verificationDisposition"
const EXECUTE_TEMPLATE_ID = "scheduled.application.execute"

export type TaskGraphSnapshotPackageRefs = Readonly<{
  valid: boolean
  shape: boolean
  packageRefs?: string[]
}>

export function taskGraphSnapshotStringList(value: unknown, maxItems: number, maxLength: number, allowEmpty: boolean): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return false
  for (const key of keys) {
    if (key === "length") continue
    if (typeof key !== "string") return false
    const index = Number(key)
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key
      || !text(value[index], maxLength)) return false
  }
  return true
}

export function parseTaskGraphSnapshotPackageRefs(value: Record<string, unknown>): TaskGraphSnapshotPackageRefs {
  const hasRefs = Object.hasOwn(value, "packageRefs"), isExecute = value.templateId === EXECUTE_TEMPLATE_ID
  const shape = exactKeys(value, PACKAGE_REFS_NODE_KEYS)
  if (!hasRefs && !isExecute) return { valid: true, shape: false }
  if (!hasRefs || !isExecute || !shape || value.verificationDisposition !== "specialized"
    || !taskGraphSnapshotStringList(value.packageRefs, TASK_GRAPH_LIMITS.maxScheduledPackageRefs, 256, true)) return { valid: false, shape }
  const refs = value.packageRefs as string[]
  if (refs.some(ref => ref.trim() !== ref || /[\u0000-\u001f\u007f]/.test(ref)) || new Set(refs).size !== refs.length) {
    return { valid: false, shape }
  }
  return { valid: true, shape, packageRefs: [...refs] }
}

export function taskGraphSnapshotCapacityValid(nodes: readonly Readonly<{
  key: string; templateId: string; depth: number; dependsOn: readonly string[]; packageRefs?: readonly string[]
}>[]): boolean {
  const hasPostGateNodes = nodes.some(node => node.templateId === EXECUTE_TEMPLATE_ID || node.templateId === "scheduled.post_gate_audit")
  if (nodes.length <= TASK_GRAPH_LIMITS.maxNodes && !hasPostGateNodes) return true
  const scheduled = projectScheduledPipelineGraphAtCurrentStage(nodes)
  return scheduled?.version === "v2" && scheduled.projection.stage === "audit" && scheduled.projection.executes.length > 0
}

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}

