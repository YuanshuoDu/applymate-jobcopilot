import { canonicalTaskGraphJson, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseScheduledGateTaskEnvelope, scheduledGatePreparedJobIdsFromResult, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"
import { parseScheduledAuditTaskEnvelope, SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL,
  SCHEDULED_AUDIT_OUTPUT_SCHEMA, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"

type EnvelopeTask = Readonly<{ id: string; status: string; role: string; taskType?: string; expectedOutputSchema?: unknown;
  allowedActions?: unknown; contextIsEmpty?: boolean; failureReason: string | null; result: unknown }>
type SpecializedEnvelopeInput = Readonly<{ snapshot: TaskGraphSnapshot | null;
  tasks: ReadonlyMap<string, EnvelopeTask>; node: TaskGraphSnapshot["nodes"][number]; task: EnvelopeTask }>

export function isScheduledTaskGraphSpecializedEnvelope(input: SpecializedEnvelopeInput): "gate" | "audit" | null {
  if (scheduledGateEnvelope(input)) return "gate"
  return scheduledAuditEnvelope(input) ? "audit" : null
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
