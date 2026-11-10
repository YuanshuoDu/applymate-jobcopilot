import { canonicalTaskGraphJson, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseScheduledGateTaskEnvelope, scheduledGatePreparedJobIdsFromResult, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"
import { parseScheduledAuditTaskEnvelope, SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL,
  SCHEDULED_AUDIT_OUTPUT_SCHEMA, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"
import { parseScheduledPostGateExecuteTaskEnvelope, SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL,
  SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
  SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_EXECUTE_ROLE,
  SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID } from "./scheduled-post-gate-contract.js"

type EnvelopeTask = Readonly<{ id: string; status: string; role: string; taskType?: string; expectedOutputSchema?: unknown;
  allowedActions?: unknown; contextIsEmpty?: boolean; failureReason: string | null; result: unknown }>
type SpecializedEnvelopeInput = Readonly<{ snapshot: TaskGraphSnapshot | null;
  tasks: ReadonlyMap<string, EnvelopeTask>; node: TaskGraphSnapshot["nodes"][number]; task: EnvelopeTask }>

export function isScheduledTaskGraphSpecializedEnvelope(input: SpecializedEnvelopeInput): "gate" | "execute" | "audit" | null {
  if (scheduledGateEnvelope(input)) return "gate"
  if (scheduledPostGateExecuteEnvelope(input)) return "execute"
  return scheduledAuditEnvelope(input) || scheduledPostGateAuditEnvelope(input) ? "audit" : null
}

function scheduledPostGateExecuteEnvelope({ snapshot, node, task }: SpecializedEnvelopeInput): boolean {
  if (!snapshot) return false
  const currentNode = snapshot.nodes.find(candidate => candidate.key === node.key && candidate.taskId === node.taskId)
  if (!currentNode || currentNode.templateId !== SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID
    || currentNode.depth !== 5 || currentNode.verificationDisposition !== "specialized" || currentNode.verification !== undefined
    || !Array.isArray(currentNode.packageRefs) || !Array.isArray(currentNode.dependsOn) || currentNode.dependsOn.length !== 1
    || currentNode.dependsOn[0] !== SCHEDULED_GATE_TEMPLATE_ID
    || task.id !== currentNode.taskId || task.status !== "completed" || task.failureReason !== null
    || task.role !== SCHEDULED_POST_GATE_EXECUTE_ROLE || task.taskType !== SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE
    || !sameJson(task.expectedOutputSchema, SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA) || !sameJson(task.allowedActions, []) || task.contextIsEmpty !== true
    || !parseScheduledPostGateExecuteTaskEnvelope(task.result, task.status, currentNode.packageRefs)) return false
  const gate = snapshot.nodes.find(candidate => candidate.key === SCHEDULED_GATE_TEMPLATE_ID)
  const audit = snapshot.nodes.find(candidate => candidate.key === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID)
  const executes = snapshot.nodes.filter(candidate => candidate.templateId === SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID)
  const executeKeys = executes.map(candidate => candidate.key), executeTaskIds = executes.map(candidate => candidate.taskId)
  return gate?.templateId === SCHEDULED_GATE_TEMPLATE_ID && gate.depth === 4 && gate.verificationDisposition === "specialized"
    && audit?.templateId === SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID && audit.depth === 6
    && audit.verificationDisposition === "specialized" && executes.length >= 1 && executes.length <= 3
    && new Set(executeKeys).size === executes.length && new Set(executeTaskIds).size === executes.length
    && sameStringSet(audit.dependsOn, executeKeys)
}

function scheduledPostGateAuditEnvelope({ snapshot, tasks, node, task }: SpecializedEnvelopeInput): boolean {
  if (!snapshot || node.key !== SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID || node.templateId !== SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID
    || node.depth !== 6 || node.verificationDisposition !== "specialized" || node.verification !== undefined
    || node.goal !== SCHEDULED_POST_GATE_AUDIT_GOAL || !sameJson(node.successCriteria, SCHEDULED_POST_GATE_AUDIT_CRITERIA)
    || task.id !== node.taskId || task.role !== SCHEDULED_POST_GATE_AUDIT_ROLE || task.taskType !== SCHEDULED_POST_GATE_AUDIT_TASK_TYPE
    || task.status !== "completed" || task.failureReason !== null || task.contextIsEmpty !== true
    || !sameJson(task.expectedOutputSchema, SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA) || !sameJson(task.allowedActions, [])
    || !parseScheduledAuditTaskEnvelope(task.result, task.status)) return false
  const gate = snapshot.nodes.find(candidate => candidate.key === SCHEDULED_GATE_TEMPLATE_ID)
  const executes = snapshot.nodes.filter(candidate => candidate.templateId === SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID)
  return gate?.depth === 4 && executes.length >= 1 && executes.length <= 3
    && executes.every(execute => execute.depth === 5 && execute.verificationDisposition === "specialized"
      && tasks.get(execute.taskId)?.status === "completed")
    && sameStringSet(node.dependsOn, executes.map(candidate => candidate.key))
}

function scheduledGateEnvelope(input: SpecializedEnvelopeInput): boolean {
  const { snapshot, tasks, node, task } = input
  if (node.key !== SCHEDULED_GATE_TEMPLATE_ID || node.templateId !== SCHEDULED_GATE_TEMPLATE_ID
    || node.verificationDisposition !== "specialized" || task.role !== SCHEDULED_GATE_ROLE
    || task.taskType !== SCHEDULED_GATE_TASK_TYPE || task.contextIsEmpty !== true
    || !sameJson(task.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) || !sameJson(task.allowedActions, [])
    || task.status !== "waiting_for_user" && task.status !== "completed") return false
  const prepareNode = snapshot?.nodes.find(candidate => candidate.key === "prepare")
  const prepare = prepareNode && tasks.get(prepareNode.taskId), prepareResult = parseObject(prepare?.result)
  const facts = parseObject(prepareResult?.taskGraphScheduledPrepareProofFacts)
  if (!prepareNode || prepareNode.templateId !== "prepare" || prepareNode.verificationDisposition !== "specialized"
    || !prepare || prepare.role !== "prepare" || prepare.taskType !== "scheduled_application_prepare" || prepare.status !== "completed"
    || !facts || facts.schemaVersion !== SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA
    || canonicalTaskGraphJson(facts.result) !== canonicalTaskGraphJson(prepareResult?.structuredResult)) return false
  const preparedIds = scheduledGatePreparedJobIdsFromResult(facts.result)
  return preparedIds !== null && parseScheduledGateTaskEnvelope(task.result, task.status, preparedIds) !== null
}

function scheduledAuditEnvelope({ node, task }: SpecializedEnvelopeInput): boolean {
  return node.key === SCHEDULED_AUDIT_TEMPLATE_ID && node.templateId === SCHEDULED_AUDIT_TEMPLATE_ID
    && node.depth === 5 && node.verificationDisposition === "specialized" && node.verification === undefined
    && node.goal === SCHEDULED_AUDIT_NODE_GOAL && sameJson(node.successCriteria, SCHEDULED_AUDIT_NODE_CRITERIA)
    && sameJson(node.dependsOn, [SCHEDULED_GATE_TEMPLATE_ID]) && task.id === node.taskId
    && task.role === SCHEDULED_AUDIT_ROLE && task.taskType === SCHEDULED_AUDIT_TASK_TYPE
    && task.status === "completed" && task.failureReason === null && task.contextIsEmpty === true
    && sameJson(task.expectedOutputSchema, SCHEDULED_AUDIT_OUTPUT_SCHEMA) && sameJson(task.allowedActions, [])
    && parseScheduledAuditTaskEnvelope(task.result, task.status) !== null
}

function parseObject(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every(value => right.includes(value))
}
