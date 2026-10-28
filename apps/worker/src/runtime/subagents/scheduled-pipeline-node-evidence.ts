import { taskGraphVerificationDependencyNodeKeys, type TaskGraphVerificationEvidenceProjection } from '../planning/task-graph-verification.js'
import { TASK_GRAPH_TEMPLATES } from './task-graph-templates.js'
import { canonicalTaskGraphJson, type StoredTaskGraphNode, type TaskGraphSnapshot } from './task-graph-snapshot.js'
import { parseStoredTaskGraphVerificationReport, publicTaskGraphVerificationReport, type TaskGraphStoredVerificationReport } from './task-graph-verification-report.js'
import type { TaskGraphCurrentNode, TaskGraphCurrentState } from './task-graph-command-port.js'
import type { ScheduledAutomationPersistedTask, ScheduledAutomationPipelineBridgeScope } from './scheduled-automation-pipeline-bridge.js'
import type { TaskGraphVerificationCheck } from '../planning/task-graph-verification-contract.js'
import { validateRoleResult, type AnalystResult, type ScoutResult } from './role-results.js'

export type ScheduledPipelineNodeEvidence = Readonly<{
  node: StoredTaskGraphNode
  current: TaskGraphCurrentNode
  task: ScheduledAutomationPersistedTask
  envelope: Record<string, unknown>
  report: TaskGraphStoredVerificationReport
}>

export function readScheduledPipelineNodeEvidence(
  snapshot: TaskGraphSnapshot,
  current: TaskGraphCurrentState,
  tasks: readonly ScheduledAutomationPersistedTask[],
  scope: ScheduledAutomationPipelineBridgeScope,
  expectedCount: number,
): ScheduledPipelineNodeEvidence[] | null {
  if (!Number.isSafeInteger(current.revision) || current.revision < 0 || snapshot.nodes.length !== expectedCount
    || current.nodes.length !== expectedCount || tasks.length !== expectedCount) return null
  const rows: ScheduledPipelineNodeEvidence[] = []
  for (const node of snapshot.nodes) {
    const currentRows = current.nodes.filter(value => value.key === node.key), taskRows = tasks.filter(value => value.id === node.taskId)
    const currentNode = currentRows[0], task = taskRows[0]
    if (currentRows.length !== 1 || taskRows.length !== 1 || !currentNode || !task || currentNode.taskId !== node.taskId
      || currentNode.templateId !== node.templateId || !sameJson(currentNode.dependsOn, node.dependsOn) || currentNode.status !== 'completed'
      || currentNode.failureReason !== null || !taskIdentityMatches(task, scope) || task.status !== 'completed'
      || task.failureReason !== null || !validAttempt(task.attemptCount)) return null
    const envelope = parseEnvelope(task.result, node.templateId === 'scout')
    if (!envelope || !node.verification) return null
    const dependencyKeys = taskGraphVerificationDependencyNodeKeys(node.verification)
    const report = parseStoredTaskGraphVerificationReport(envelope.taskGraphVerificationReport,
      node.verification.criteria.map(item => item.id), dependencyKeys)
    if (!report || report.status !== 'passed' || !report.resultDigest || !report.evidenceDigest
      || !sameJson(currentNode.verificationReport, publicTaskGraphVerificationReport(report))) return null
    rows.push({ node, current: currentNode, task, envelope, report })
  }
  return rows
}

export function isScheduledScoutNode(item: ScheduledPipelineNodeEvidence): boolean {
  return item.node.templateId === 'scout' && item.node.dependsOn.length === 0 && item.node.verificationDisposition === 'typed'
    && item.node.verification?.role === 'scout' && item.task.role === 'scout' && item.task.taskType === TASK_GRAPH_TEMPLATES.scout.taskType
    && schemaRole(item.task.expectedOutputSchema, 'scout') && sameJson(item.task.allowedActions, TASK_GRAPH_TEMPLATES.scout.allowedActions)
}

export function isScheduledAnalystNode(item: ScheduledPipelineNodeEvidence, scouts: readonly ScheduledPipelineNodeEvidence[]): boolean {
  const contract = item.node.verification, keys = scouts.map(source => source.node.key)
  if (item.node.templateId !== 'analyst' || item.node.verificationDisposition !== 'typed' || contract?.role !== 'analyst'
    || item.node.dependsOn.length !== keys.length || !sameSet(item.node.dependsOn, keys)
    || item.task.role !== 'analyst' || item.task.taskType !== TASK_GRAPH_TEMPLATES.analyst.taskType
    || !schemaRole(item.task.expectedOutputSchema, 'analyst') || !sameJson(item.task.allowedActions, TASK_GRAPH_TEMPLATES.analyst.allowedActions)) return false
  const selectors = taskGraphVerificationDependencyNodeKeys(contract)
  if (selectors.some(key => !keys.includes(key))) return false
  if (scouts.length === 1) return selectors.length === 1 && selectors[0] === keys[0]
  return contract.criteria.some(criterion => isFullUnionMembership(criterion.check, keys))
}

function isFullUnionMembership(check: TaskGraphVerificationCheck, keys: readonly string[]): boolean {
  return check.kind === 'findings_from_scout_union' && sameSet(check.dependencyNodeKeys, keys)
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && left.every(value => right.includes(value))
}
function taskIdentityMatches(task: ScheduledAutomationPersistedTask, scope: ScheduledAutomationPipelineBridgeScope): boolean {
  return task.userId === scope.userId && task.sessionId === scope.sessionId && task.turnId === scope.turnId
    && task.rootTaskId === scope.rootTaskId && task.parentTaskId === scope.rootTaskId
}
function parseEnvelope(value: unknown, withDiscovery: boolean): Record<string, unknown> | null {
  const parsed = row(value), base = ['finalItemId', 'finalText', 'status', 'stepCount', 'structuredResult', 'taskGraphVerificationReport', 'toolCallCount']
  const keys = Object.keys(parsed ?? {}).sort().join(','), expected = [...base].sort().join(',')
  if (!parsed || (keys !== expected && (!withDiscovery || keys !== [...base, 'discoveryAttempt'].sort().join(','))) || parsed.status !== 'completed'
    || parsed.finalItemId !== null && typeof parsed.finalItemId !== 'string' || typeof parsed.finalText !== 'string'
    || !Number.isSafeInteger(parsed.stepCount) || Number(parsed.stepCount) < 0 || !Number.isSafeInteger(parsed.toolCallCount)
    || Number(parsed.toolCallCount) < 0 || !Object.hasOwn(parsed, 'structuredResult')) return null
  return parsed
}
export function parseScheduledPipelineRoleResult(value: unknown, role: 'scout'): ScoutResult | null
export function parseScheduledPipelineRoleResult(value: unknown, role: 'analyst'): AnalystResult | null
export function parseScheduledPipelineRoleResult(value: unknown, role: string): ScoutResult | AnalystResult | null {
  if (role !== 'scout' && role !== 'analyst') return null
  try { return validateRoleResult(value, role) } catch { return null }
}
function schemaRole(value: unknown, role: 'scout' | 'analyst'): boolean {
  const parsed = row(value)
  return Boolean(parsed && Object.keys(parsed).sort().join(',') === 'role,schemaVersion' && parsed.role === role
    && parsed.schemaVersion === 'agent-harness.v2.subagent.result')
}
function validAttempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function row(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null } catch { return null }
}
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
