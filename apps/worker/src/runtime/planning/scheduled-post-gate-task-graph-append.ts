import type {
  TaskGraphAppendResult,
  TaskGraphFailure,
  TaskGraphNodeProposal,
  TaskGraphRepairOf,
  TaskGraphState,
  TaskGraphValidationOptions,
  TaskGraphValidationResult,
} from "./task-graph.js"

const EXECUTE_TEMPLATE_ID = "scheduled.application.execute"
const PACKAGE_REFS_NODE_KEYS = [
  "dependsOn,goal,key,packageRefs,successCriteria,templateId",
  "dependsOn,goal,key,packageRefs,successCriteria,templateId,verification",
  "dependsOn,goal,key,packageRefs,repairOf,successCriteria,templateId,verification",
] as const

export type ScheduledTaskGraphNodeShapeCheck = (value: unknown, keys: string) => value is Record<string, unknown>
export type ScheduledTaskGraphStringListCheck = (value: unknown, allowEmpty: boolean, maxItems: number, maxLength: number) => value is string[]
export type ScheduledTaskGraphTextCheck = (value: unknown, maxLength: number) => value is string

export function taskGraphProposalTextArray(value: unknown, allowEmpty: boolean, maxItems: number, maxLength: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return false
  for (const key of keys) {
    if (key === "length") continue
    if (typeof key !== "string") return false
    const index = Number(key)
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key
      || !proposalText(value[index], maxLength)) return false
  }
  return true
}

export function parseTaskGraphProposalRepairOf(value: unknown, index: number, options: Readonly<{
  plainRecord: ScheduledTaskGraphNodeShapeCheck
  text: ScheduledTaskGraphTextCheck
  textArray: ScheduledTaskGraphStringListCheck
  maxKeyLength: number
  maxCriteria: number
}>): TaskGraphRepairOf | TaskGraphFailure {
  const path = `nodes[${index}].repairOf`
  if (!options.plainRecord(value, "criterionIds,graphRootTaskId,nodeKey,taskId") || !options.text(value.graphRootTaskId, 128)
    || !options.text(value.nodeKey, options.maxKeyLength) || !options.text(value.taskId, options.maxKeyLength)
    || !options.textArray(value.criterionIds, false, options.maxCriteria, 64)
    || new Set(value.criterionIds).size !== value.criterionIds.length) {
    return { ok: false, error: { code: "invalid_shape", path, message: "repairOf must name a root, prior node, task, and unique criteria" } }
  }
  return { graphRootTaskId: value.graphRootTaskId as string, nodeKey: value.nodeKey as string, taskId: value.taskId as string,
    criterionIds: [...value.criterionIds as string[]] }
}

export function hasScheduledTaskGraphPackageRefsShape(value: unknown, matches: ScheduledTaskGraphNodeShapeCheck): boolean {
  return PACKAGE_REFS_NODE_KEYS.some(keys => matches(value, keys))
}

export function parseScheduledTaskGraphPackageRefs(
  value: Record<string, unknown>, maxRefs: number, listIsValid: ScheduledTaskGraphStringListCheck,
): Readonly<{ valid: true; packageRefs?: readonly string[] }> | Readonly<{ valid: false }> {
  const hasRefs = Object.hasOwn(value, "packageRefs")
  if (value.templateId !== EXECUTE_TEMPLATE_ID) return hasRefs ? { valid: false } : { valid: true }
  if (!hasRefs || !listIsValid(value.packageRefs, true, maxRefs, 256)) return { valid: false }
  const refs = value.packageRefs as string[]
  if (refs.some(ref => ref.trim() !== ref || /[\u0000-\u001f\u007f]/.test(ref)) || new Set(refs).size !== refs.length) {
    return { valid: false }
  }
  return { valid: true, packageRefs: [...refs] }
}

function proposalText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
}

export type ScheduledPostGateTaskGraphLimits = Readonly<{
  maxPersistedNodes: number
  maxScheduledPostGateAppendNodes: number
  maxScheduledPackageRefs: number
}>
export type TaskGraphWithinLimitValidator = (
  value: unknown, state: TaskGraphState, options: TaskGraphValidationOptions, hardMaxNodes: number, maxAddedNodes: number,
) => TaskGraphValidationResult

export function createScheduledPostGateTaskGraphAppender(
  validate: TaskGraphWithinLimitValidator, limits: ScheduledPostGateTaskGraphLimits,
): (state: TaskGraphState, value: unknown, options: TaskGraphValidationOptions) => TaskGraphAppendResult {
  return (state, value, options) => {
    const validation = validate(value, state, options, limits.maxPersistedNodes, limits.maxScheduledPostGateAppendNodes)
    if (!validation.ok) return validation
    if (!validPostGateSuffix(validation.proposal.nodes, limits)) return failure()
    return {
      ok: true,
      state: {
        revision: state.revision + 1,
        nodes: [...state.nodes, ...validation.addedNodes],
        appliedEvents: state.appliedEvents,
        repairSatisfiedNodeKeys: state.repairSatisfiedNodeKeys,
        repairPendingNodeKeys: state.repairPendingNodeKeys,
      },
      addedNodes: validation.addedNodes,
    }
  }
}

function validPostGateSuffix(nodes: readonly TaskGraphNodeProposal[], limits: ScheduledPostGateTaskGraphLimits): boolean {
  const audit = nodes[nodes.length - 1]
  if (!audit) return false
  if (nodes.length === 1) return audit.key === "scheduled_audit" && audit.templateId === "scheduled_audit"
    && audit.dependsOn.length === 1 && audit.dependsOn[0] === "gate"
  const executes = nodes.slice(0, -1)
  if (executes.length < 1 || executes.length > 3 || nodes.length > limits.maxScheduledPostGateAppendNodes
    || audit.key !== "scheduled.post_gate_audit" || audit.templateId !== "scheduled.post_gate_audit") return false
  const refs = new Set<string>()
  for (const node of executes) {
    if (node.templateId !== EXECUTE_TEMPLATE_ID || !node.packageRefs
      || node.dependsOn.length !== 1 || node.dependsOn[0] !== "gate"
      || executes.length > 1 && node.packageRefs.length === 0) return false
    for (const ref of node.packageRefs) {
      if (refs.has(ref)) return false
      refs.add(ref)
      if (refs.size > limits.maxScheduledPackageRefs) return false
    }
  }
  const executeKeys = executes.map(node => node.key)
  return audit.dependsOn.length === executeKeys.length && new Set(audit.dependsOn).size === executeKeys.length
    && executeKeys.every(key => audit.dependsOn.includes(key))
}

function failure(): TaskGraphAppendResult {
  return { ok: false, error: { code: "invalid_shape", path: "nodes",
    message: "Scheduled post-Gate append must contain the fixed Audit or a bounded Execute/Audit suffix" } }
}
