import type { TaskGraphProposal } from "../planning/task-graph.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import {
  SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_CRITERIA, SCHEDULED_POST_GATE_EXECUTE_GOAL, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID,
} from "./scheduled-post-gate-contract.js"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
export type ScheduledPostGatePlanShape = Readonly<{
  executeNodes: readonly TaskGraphProposal["nodes"][number][]
  auditNode: TaskGraphProposal["nodes"][number]
  packageRefs: readonly string[]
}>

/** Exact server-gated suffix: only bounded Execute nodes plus their one downstream Audit. */
export function parseScheduledPostGatePlan(proposal: TaskGraphProposal, expectedRevision: number,
  approvedPackageRefs: readonly string[]): ScheduledPostGatePlanShape | null {
  if (!exactKeys(proposal, ["expectedRevision", "nodes"]) || !Number.isSafeInteger(expectedRevision) || proposal.expectedRevision !== expectedRevision
    || !Array.isArray(proposal.nodes) || proposal.nodes.length < 2 || proposal.nodes.length > 4
    || !validRefs(approvedPackageRefs, true)) return null
  const executeNodes = proposal.nodes.slice(0, -1), auditNode = proposal.nodes.at(-1)
  if (!auditNode || !exactKeys(auditNode, ["dependsOn", "goal", "key", "successCriteria", "templateId"])
    || executeNodes.length < 1 || executeNodes.length > 3 || auditNode.key !== SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID
    || auditNode.templateId !== SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID || auditNode.goal !== SCHEDULED_POST_GATE_AUDIT_GOAL
    || !sameStrings(auditNode.successCriteria, SCHEDULED_POST_GATE_AUDIT_CRITERIA)
    || !sameSet(auditNode.dependsOn, executeNodes.map(node => node.key))) return null
  const covered: string[] = []
  for (const node of executeNodes) {
    if (!exactKeys(node, ["dependsOn", "goal", "key", "packageRefs", "successCriteria", "templateId"])
      || node.templateId !== SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID || !validId(node.key) || !validRefs(node.packageRefs, true)
      || !sameStrings(node.dependsOn, ["gate"]) || node.verification !== undefined || node.repairOf !== undefined
      || node.nativeDelegation !== undefined || node.goal !== SCHEDULED_POST_GATE_EXECUTE_GOAL
      || !sameStrings(node.successCriteria, SCHEDULED_POST_GATE_EXECUTE_CRITERIA)) return null
    if (executeNodes.length > 1 && node.packageRefs.length === 0) return null
    covered.push(...node.packageRefs)
  }
  if (new Set(executeNodes.map(node => node.key)).size !== executeNodes.length || new Set(covered).size !== covered.length
    || !sameSet(covered, approvedPackageRefs) || approvedPackageRefs.length === 0
      && (executeNodes.length !== 1 || executeNodes[0]?.packageRefs.length !== 0)) return null
  return { executeNodes, auditNode, packageRefs: [...approvedPackageRefs] }
}

function validRefs(value: unknown, allowEmpty: boolean): value is readonly string[] {
  if (!Array.isArray(value) || value.length > TASK_GRAPH_LIMITS.maxScheduledPackageRefs
    || !allowEmpty && value.length === 0) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string"
    && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
    && value.every(validId) && new Set(value).size === value.length
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !CONTROL_CHARACTERS.test(value)
}
function sameStrings(value: readonly string[], expected: readonly string[]): boolean {
  return validStringArray(value, expected.length) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index])
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return validStringArray(left, right.length) && left.length === right.length
    && new Set(left).size === left.length && left.every(value => right.includes(value))
}
function validStringArray(value: readonly string[], max: number): boolean {
  if (!Array.isArray(value) || value.length > max) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string"
    && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
    && value.every(validId)
}
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && "value" in Object.getOwnPropertyDescriptor(value, key)!)
}
