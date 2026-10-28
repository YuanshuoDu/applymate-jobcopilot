import { projectScheduledPipelineGraph, type ScheduledPipelineGraphStage, type ScheduledPipelineGraphVersion } from './scheduled-pipeline-graph-shape.js'
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type TaskGraphSnapshot } from './task-graph-snapshot.js'
import { TASK_GRAPH_TEMPLATES } from './task-graph-templates.js'
import type { TaskGraphCurrentState } from './task-graph-command-port.js'
import { parseScheduledTaskGraphContinuationReceipt, scheduledTaskGraphContinuationKeyVersion, scheduledTaskGraphStableContinuationKey } from './scheduled-taskgraph-continuation-receipt.js'
import { scheduledPrepareResultDigest, SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA } from './scheduled-prepare-task-graph-verification.js'
import { validateRoleResult } from './role-results.js'
import { SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from './scheduled-gate-contract.js'
import { SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_OUTPUT_SCHEMA, SCHEDULED_AUDIT_ROLE, SCHEDULED_AUDIT_TASK_TYPE, SCHEDULED_AUDIT_TEMPLATE_ID } from './scheduled-audit-contract.js'

type PipelineTask = Readonly<{ id: string; role: string; taskType: string; status: string; attemptCount: number; failureReason: string | null;
  expectedOutputSchema: unknown; allowedActions: unknown; result?: unknown; rootTaskId?: string; parentTaskId?: string }>
export type ScheduledAnalyzePrefix<T extends PipelineTask = PipelineTask> = Readonly<{ snapshot: TaskGraphSnapshot; current: TaskGraphCurrentState; tasks: readonly T[] }>
const PREPARE_GOAL = 'Prepare application materials using the persisted scheduled Analyze checkpoint.'
const PREPARE_CRITERIA = ['Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.',
  'Persist immutable owner-fenced material references and return no resume or letter bodies.']

/** Reconstructs only the immutable Analyze prefix after any scheduled suffix has been appended. */
export function projectScheduledAnalyzePrefix<T extends PipelineTask>(snapshotValue: unknown, current: TaskGraphCurrentState, tasks: readonly T[]): ScheduledAnalyzePrefix<T> | null {
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(snapshotValue) } catch { return null }
  const sourceCount = snapshot.nodes.findIndex(node => node.templateId !== 'scout')
  const scouts = sourceCount < 0 ? snapshot.nodes.length : sourceCount
  const suffix = snapshot.nodes.length - scouts - 1
  const version: ScheduledPipelineGraphVersion = scouts === 1 ? 'v1' : 'v2'
  const stage: ScheduledPipelineGraphStage | null = suffix === 0 ? 'analyze' : suffix === 1 ? 'prepare' : suffix === 2 ? 'gate' : suffix === 3 ? 'audit' : null
  const graph = stage && projectScheduledPipelineGraph(snapshot.nodes, version, stage)
  const baseCount = scouts + 1
  if (!graph || current.nodes.length !== snapshot.nodes.length || tasks.length !== snapshot.nodes.length
    || !Number.isSafeInteger(current.revision) || current.revision < snapshot.nodes.length) return null
  const sourceTasks = graph.scouts.map(node => prefixTask(node, tasks, TASK_GRAPH_TEMPLATES.scout.role, TASK_GRAPH_TEMPLATES.scout.taskType))
  const analystNode = graph.analyst, analystTask = prefixTask(analystNode, tasks, TASK_GRAPH_TEMPLATES.analyst.role, TASK_GRAPH_TEMPLATES.analyst.taskType)
  if (sourceTasks.some(task => !task) || !analystTask) return null
  const baseSnapshot = parseTaskGraphSnapshot({ schemaVersion: snapshot.schemaVersion, nodes: snapshot.nodes.slice(0, baseCount),
    ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}) })
  let analyzeRevision = current.revision
  if (graph.stage !== 'analyze') {
    const prepareNode = graph.prepare, prepareState = current.nodes.find(node => node.key === prepareNode.key)
    const prepareTask = prefixTask(prepareNode, tasks, TASK_GRAPH_TEMPLATES.prepare.role, TASK_GRAPH_TEMPLATES.prepare.taskType)
    if (!prepareState || !prepareTask || prepareNode.key !== 'prepare' || prepareNode.templateId !== 'prepare' || prepareNode.depth !== 3
      || prepareNode.dependsOn.length !== 1 || prepareNode.dependsOn[0] !== analystNode.key || prepareNode.verificationDisposition !== 'specialized'
      || prepareNode.verification !== undefined || prepareNode.goal !== PREPARE_GOAL || !sameJson(prepareNode.successCriteria, PREPARE_CRITERIA)
      || prepareState.taskId !== prepareNode.taskId || prepareState.templateId !== 'prepare' || prepareState.status !== prepareTask.status
      || prepareState.failureReason !== prepareTask.failureReason || prepareTask.status !== 'completed' || prepareTask.failureReason !== null
      || !validAttempt(prepareTask.attemptCount) || !sameJson(prepareTask.expectedOutputSchema, TASK_GRAPH_TEMPLATES.prepare.expectedOutputSchema)
      || !sameJson(prepareTask.allowedActions, TASK_GRAPH_TEMPLATES.prepare.allowedActions)) return null
    const prepared = prepareAnalyzeRevision(prepareTask, snapshot, current.revision, baseCount, version)
    if (prepared === null) return null
    analyzeRevision = prepared
    if (graph.stage === 'gate' || graph.stage === 'audit') {
      if (!validSuffixTask(graph.gate, current, tasks, prepareTask, 'gate')) return null
    }
    if (graph.stage === 'audit') {
      const gate = graph.gate, gateTask = tasks.find(task => task.id === gate.taskId)
      if (!gateTask || gateTask.status !== 'completed' || !validSuffixTask(graph.audit, current, tasks, gateTask, 'audit')) return null
    }
  }
  const readySourceTasks = sourceTasks.filter((task): task is T => task !== null)
  return { snapshot: baseSnapshot, current: { revision: analyzeRevision, nodes: current.nodes.slice(0, baseCount),
    ...(current.rootSuccessCriteria ? { rootSuccessCriteria: current.rootSuccessCriteria } : {}) }, tasks: [...readySourceTasks, analystTask] }
}

function prepareAnalyzeRevision<T extends PipelineTask>(task: T, snapshot: TaskGraphSnapshot, currentRevision: number, prefixCount: number,
  version: ScheduledPipelineGraphVersion): number | null {
  const envelope = record(task.result), facts = record(envelope?.taskGraphScheduledPrepareProofFacts), receipt = parseScheduledTaskGraphContinuationReceipt(facts?.receipt)
  const completion = record(facts?.completion), completionNodes = completion && Array.isArray(completion.nodes) ? completion.nodes : null
  if (!envelope || envelope.status !== 'completed' || !sameJson(envelope.structuredResult, facts?.result) || !facts
    || !exact(facts, ['schemaVersion', 'receipt', 'completion', 'result']) || facts.schemaVersion !== SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA
    || !receipt || receipt.continuationKey !== scheduledTaskGraphStableContinuationKey(receipt)
    || scheduledTaskGraphContinuationKeyVersion(receipt.continuationKey) !== version || receipt.prepareScheduleRevision !== receipt.analyzeGraphRevision + 1
    || receipt.prepareScheduleRevision > currentRevision || !completion || !exact(completion, ['schemaVersion', 'graphRevision', 'nodes'])
    || completion.schemaVersion !== SCHEDULED_PREPARE_COMPLETION_SCHEMA || !positive(completion.graphRevision)
    || completion.graphRevision <= receipt.prepareScheduleRevision || completion.graphRevision > currentRevision
    || !completionNodes || completionNodes.length !== prefixCount + 1 || receipt.owner.rootTaskId !== task.parentTaskId || task.rootTaskId !== task.parentTaskId) return null
  let result: ReturnType<typeof validatePrepareResult>
  try { result = validatePrepareResult(facts.result) } catch { return null }
  const prepareIndex = prefixCount
  if (result.status !== 'completed' || result.taskId !== task.id || result.attemptCount !== task.attemptCount
    || result.snapshotDigest !== receipt.snapshotDigest || result.checkpointDigest !== receipt.checkpointDigest
    || scheduledPrepareResultDigest(result) !== record(completionNodes[prepareIndex])?.resultDigest) return null
  const expected = snapshot.nodes.slice(0, prefixCount + 1)
  for (let index = 0; index < expected.length; index++) {
    const node = expected[index]!, certified = record(completionNodes[index]), expectedDeps = node.dependsOn.map(key => snapshot.nodes.find(value => value.key === key)?.taskId).filter((id): id is string => Boolean(id)).sort()
    if (!certified || node.taskId !== certified.taskId || node.templateId !== certified.role || certified.status !== 'completed'
      || certified.verification !== 'passed' || !validAttempt(certified.attemptCount) || !Array.isArray(certified.dependsOnTaskIds)
      || !sameJson([...certified.dependsOnTaskIds].sort(), expectedDeps)) return null
  }
  return receipt.analyzeGraphRevision
}

function validSuffixTask<T extends PipelineTask>(node: TaskGraphSnapshot['nodes'][number], current: TaskGraphCurrentState, tasks: readonly T[], parent: T, kind: 'gate' | 'audit'): boolean {
  const gate = kind === 'gate', key = gate ? SCHEDULED_GATE_TEMPLATE_ID : SCHEDULED_AUDIT_TEMPLATE_ID
  const role = gate ? SCHEDULED_GATE_ROLE : SCHEDULED_AUDIT_ROLE, taskType = gate ? SCHEDULED_GATE_TASK_TYPE : SCHEDULED_AUDIT_TASK_TYPE
  const goal = gate ? SCHEDULED_GATE_NODE_GOAL : SCHEDULED_AUDIT_NODE_GOAL, criteria = gate ? SCHEDULED_GATE_NODE_CRITERIA : SCHEDULED_AUDIT_NODE_CRITERIA
  const schema = gate ? SCHEDULED_GATE_OUTPUT_SCHEMA : SCHEDULED_AUDIT_OUTPUT_SCHEMA, state = current.nodes.find(value => value.key === key)
  const task = tasks.find(value => value.id === node.taskId)
  return node.key === key && node.templateId === key && node.depth === (gate ? 4 : 5) && node.dependsOn.length === 1
    && node.dependsOn[0] === (gate ? 'prepare' : 'gate') && node.verificationDisposition === 'specialized' && node.verification === undefined
    && node.goal === goal && sameJson(node.successCriteria, criteria) && Boolean(state && task && state.taskId === node.taskId
      && state.templateId === key && state.status === task.status && state.failureReason === task.failureReason && task.role === role
      && task.taskType === taskType && (task.status === 'queued' || task.status === 'running' || task.status === 'waiting_for_user' || task.status === 'completed')
      && (task.status === 'queued' || validAttempt(task.attemptCount)) && task.failureReason === null && sameJson(task.expectedOutputSchema, schema)
      && sameJson(task.allowedActions, []) && task.rootTaskId === parent.rootTaskId && task.parentTaskId === parent.parentTaskId
      && task.rootTaskId === task.parentTaskId && Boolean(task.rootTaskId))
}

function prefixTask<T extends PipelineTask>(node: TaskGraphSnapshot['nodes'][number], tasks: readonly T[], role: string, taskType: string): T | null {
  const matches = tasks.filter(task => task.id === node.taskId), task = matches[0]
  return matches.length === 1 && task?.role === role && task.taskType === taskType ? task : null
}
function validatePrepareResult(value: unknown) { return validateRoleResult(value, 'prepare') }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function validAttempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
