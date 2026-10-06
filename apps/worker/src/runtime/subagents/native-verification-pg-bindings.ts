import type pg from "pg"
import { Buffer } from "node:buffer"
import { Value } from "@sinclair/typebox/value"
import { InputContentPartSchema } from "@jobcopilot/agent-protocol"
import { digestNativeVerificationValue, canonicalNativeVerificationJson } from "./native-verification-contract.js"
import { parseTaskGraphSnapshot, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { TaskGraphNativeSourceProvenance, TaskGraphReadScope } from "./task-graph-command-port.js"
import { loadNativeVerificationSourceTasks, nativeVerificationSourceIsCurrent } from "./native-verification-pg-sources.js"

export type NativeVerificationTask = Readonly<{
  id: string; parentTaskId: string | null; rootTaskId: string; turnId: string | null
  role: string; taskType: string; status: string; attemptCount: number; result: unknown
  failureReason: string | null; goal: string; successCriteria: unknown
  expectedOutputSchema: unknown; context: unknown; outputArtifactIds: unknown
}>
export type NativeVerificationOwnedState = Readonly<{
  snapshot: TaskGraphSnapshot | null
  tasks: ReadonlyMap<string, NativeVerificationTask>
  sourceTasks: ReadonlyMap<string, NativeVerificationTask>
  goal: string | null
  criteria: readonly string[]
  criteriaValid: boolean
  nativeSourcesValid: boolean
  turnGoalConflict: boolean
  turnInputDigest: string | null
  scope: TaskGraphReadScope
}>
export type NativeVerificationTarget = Readonly<{
  node: StoredTaskGraphNode
  task: NativeVerificationTask
  attempt: number
  goal: string
  criteria: readonly string[]
  resultText: string
  resultDigest: string
}>

type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
const MAX_GOAL_BYTES = 4 * 1024
const MAX_CRITERIA = 32
const MAX_CRITERION_BYTES = 2_000
const MAX_RESULT_BYTES = 16 * 1024

function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function cleanText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes
}
function validInputContentParts(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && Reflect.ownKeys(value).length === value.length + 1
    && value.every((part, index) => Object.hasOwn(value, index) && Value.Check(InputContentPartSchema, part))
}
function criterionList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CRITERIA || Reflect.ownKeys(value).length !== value.length + 1) return null
  const output: string[] = []
  for (const item of value) if (!cleanText(item, MAX_CRITERION_BYTES)) return null; else output.push(item)
  return output
}

/** Loads only graph-owned tasks under the caller's locked root and Turn. */
export async function loadNativeVerificationOwnedState(
  client: Queryable, scope: TaskGraphReadScope, snapshotValue: unknown, lockTargets = true,
): Promise<NativeVerificationOwnedState> {
  const snapshot = snapshotValue === null ? null : parseTaskGraphSnapshot(snapshotValue)
  const rootTurn = await client.query(`SELECT root."goal", root."successCriteria", turn."input"
    FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn ON turn."id" = root."turnId" AND turn."sessionId" = root."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = root."sessionId"
    WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3 AND root."rootTaskId" = $1
      AND turn."rootTaskId" = $1 AND session."userId" = $4 AND turn."userId" = $4`,
  [scope.rootTaskId, scope.sessionId, scope.turnId, scope.userId])
  if (rootTurn.rows.length !== 1) throw new Error("native_verification_root_scope_invalid")
  const root = rootTurn.rows[0] as Row
  const objective = objectiveState(root.input, { goal: root.goal, successCriteria: root.successCriteria })
  const { goal, turnGoalConflict, criteria, criteriaValid } = objective
  let turnInputDigest: string | null = null
  try { turnInputDigest = digestNativeVerificationValue(root.input) } catch { /* unavailable input is carried as a failed binding */ }

  const ids = snapshot?.nodes.map(node => node.taskId) ?? []
  const rows = ids.length ? await client.query(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."turnId", task."role", task."taskType",
      task."status", task."attemptCount", task."result", task."failureReason", task."expectedOutputSchema", task."context", task."outputArtifactIds", task."goal", task."successCriteria"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND session."userId" = $5 AND turn."userId" = $5
    ORDER BY task."id"${lockTargets ? " FOR UPDATE OF task" : ""}`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId]) : { rows: [] as Row[] }
  if (rows.rows.length !== ids.length) throw new Error("native_verification_target_scope_invalid")
  const tasks = new Map<string, NativeVerificationTask>()
  for (const value of rows.rows) {
    const row = value as Row
    if (typeof row.id !== "string" || !Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 0
      || typeof row.status !== "string" || !row.role || !row.taskType) throw new Error("native_verification_target_shape_invalid")
    tasks.set(row.id, {
      id: row.id, parentTaskId: typeof row.parentTaskId === "string" ? row.parentTaskId : null,
      rootTaskId: String(row.rootTaskId), turnId: typeof row.turnId === "string" ? row.turnId : null,
      role: String(row.role), taskType: String(row.taskType), status: row.status, attemptCount: Number(row.attemptCount),
      result: row.result ?? null, failureReason: typeof row.failureReason === "string" ? row.failureReason : null,
      goal: typeof row.goal === "string" ? row.goal : "", successCriteria: row.successCriteria ?? null,
      expectedOutputSchema: row.expectedOutputSchema ?? {}, context: row.context ?? {}, outputArtifactIds: row.outputArtifactIds ?? [],
    })
  }
  const sources = (snapshot?.nodes ?? []).flatMap(node => node.nativeDelegation?.source ? [node.nativeDelegation.source] : [])
  const sourceTasks = await loadNativeVerificationSourceTasks(client, scope, snapshot, lockTargets)
  if (snapshot) for (const node of snapshot.nodes) {
    const task = tasks.get(node.taskId)!
    if (node.nativeDelegation && (node.nativeDelegation.callerTaskId !== scope.parentTaskId
      || node.nativeDelegation.role !== task.role || node.nativeDelegation.taskType !== task.taskType)) {
      throw new Error("native_verification_target_contract_invalid")
    }
  }
  const nativeSourcesValid = sources.every(source => nativeVerificationSourceIsCurrent(snapshot, source, sourceTasks.get(source.taskId), scope))
  return { snapshot, tasks, sourceTasks, goal, criteria,
    criteriaValid: criteriaValid && criteria.length > 0 && criteria.every(item => Buffer.byteLength(item, "utf8") <= MAX_CRITERION_BYTES),
    nativeSourcesValid,
    turnGoalConflict, turnInputDigest, scope }
}

function canonicalTurnGoal(value: unknown): Readonly<{ value: string | null; valid: boolean }> {
  const envelope = record(value)
  if (!envelope) return { value: null, valid: false }
  const nested = record(envelope.input)
  const source = nested && Object.keys(nested).length > 0 ? nested : envelope
  const hasGoal = Object.hasOwn(source, "goal"), hasContent = Object.hasOwn(source, "content")
  const goal = source.goal, content = source.content
  if (hasGoal && (typeof goal !== "string" || !goal.trim() || !cleanText(goal.trim(), MAX_GOAL_BYTES))) return { value: null, valid: false }
  if (hasContent && (typeof content === "string"
    ? !content.trim() || !cleanText(content.trim(), MAX_GOAL_BYTES)
    : !validInputContentParts(content))) return { value: null, valid: false }
  if (hasGoal && typeof content === "string" && (goal as string).trim() !== content.trim()) return { value: null, valid: false }
  const selected = hasGoal ? goal : typeof content === "string" ? content : undefined
  return typeof selected === "string" ? { value: selected.trim(), valid: true } : { value: null, valid: false }
}

function criteriaField(row: Row | null, key: string): Readonly<{ value: readonly string[]; valid: boolean }> {
  if (!row || !Object.hasOwn(row, key)) return { value: [], valid: true }
  const parsed = criterionList(row[key])
  return parsed ? { value: parsed, valid: true } : { value: [], valid: false }
}

function mergeCriteria(turnCriteria: readonly string[], rootCriteria: readonly string[], goal: string | null): readonly string[] {
  const merged = [...new Set([...turnCriteria, ...rootCriteria])]
  if (merged.length > MAX_CRITERIA) return []
  return merged.length ? merged : goal ? [goal] : []
}

export type NativeVerificationObjective = Readonly<{ goal: string; criteria: readonly string[] }>

/** Shared exact objective derivation. Missing root means rootTaskStore.ensure's fresh-root goal/empty-criteria convention. */
export function deriveNativeVerificationObjective(
  turnInput: unknown, root?: Readonly<{ goal: unknown; successCriteria: unknown }>,
): NativeVerificationObjective | null {
  const objective = objectiveState(turnInput, root)
  return objective.goal && !objective.turnGoalConflict && objective.criteriaValid
    ? { goal: objective.goal, criteria: objective.criteria } : null
}

function objectiveState(turnInput: unknown, root?: Readonly<{ goal: unknown; successCriteria: unknown }>): {
  goal: string | null; turnGoalConflict: boolean; criteria: readonly string[]; criteriaValid: boolean
} {
  const envelope = record(turnInput), nested = record(envelope?.input)
  const canonicalInput = nested && Object.keys(nested).length > 0 ? nested : envelope
  const parsedGoal = canonicalTurnGoal(turnInput), goal = parsedGoal.value
  const rootGoal = root ? typeof root.goal === "string" && root.goal.trim() ? root.goal.trim() : null : goal
  const turnCriteria = criteriaField(canonicalInput, "successCriteria")
  const rootCriteria = root ? criteriaField(root, "successCriteria") : { value: [], valid: true }
  const turnGoalConflict = !parsedGoal.valid || !goal || !rootGoal || goal !== rootGoal
  const listsValid = turnCriteria.valid && rootCriteria.valid
  const criteria = listsValid ? mergeCriteria(turnCriteria.value, rootCriteria.value, goal) : []
  return { goal, turnGoalConflict, criteria, criteriaValid: listsValid && criteria.length > 0
    && criteria.every(item => Buffer.byteLength(item, "utf8") <= MAX_CRITERION_BYTES) }
}

/** A predecessor leaves the active frontier only when an owned followup still proves its exact source. */
export function nativeVerificationFrontier(state: NativeVerificationOwnedState): readonly StoredTaskGraphNode[] {
  const nodes = state.snapshot?.nodes.filter(node => node.nativeDelegation) ?? []
  if (!state.nativeSourcesValid) throw new Error("native_verification_source_stale")
  const byKey = new Map((state.snapshot?.nodes ?? []).map(node => [node.key, node] as const))
  const superseded = new Set<string>(), sourceEdges = new Map<string, string>()
  for (const child of nodes) {
    const metadata = child.nativeDelegation!, source = metadata.source
    if (metadata.operationKind !== "followup") continue
    if (!source) throw new Error("native_verification_source_stale")
    const sourceNode = source.origin === "task_graph" && source.graphNodeKey ? byKey.get(source.graphNodeKey) : undefined
    if (source.origin === "task_graph" && (!sourceNode || sourceNode.taskId !== source.taskId)) throw new Error("native_verification_source_stale")
    if (source.origin !== "task_graph" || !sourceNode?.nativeDelegation) continue
    const parent = byKey.get(source.graphNodeKey!)
    if (!parent) throw new Error("native_verification_source_stale")
    const parentIndex = nodes.findIndex(node => node.key === parent!.key), childIndex = nodes.findIndex(node => node.key === child.key)
    if (parentIndex < 0 || childIndex <= parentIndex || sourceEdges.has(child.key)) throw new Error("native_verification_source_stale")
    sourceEdges.set(child.key, parent.key)
    superseded.add(parent.key)
  }
  if (hasSourceCycle(sourceEdges, nodes.length)) throw new Error("native_verification_provenance_cycle")
  return nodes.filter(node => !superseded.has(node.key))
}

function hasSourceCycle(edges: ReadonlyMap<string, string>, max: number): boolean {
  for (const start of edges.keys()) {
    const seen = new Set<string>(); let current: string | undefined = start
    while (current && edges.has(current)) {
      if (seen.has(current) || seen.size > max) return true
      seen.add(current); current = edges.get(current)
    }
  }
  return false
}

export function nativeVerificationCriteria(node: StoredTaskGraphNode): readonly string[] {
  return node.successCriteria.length ? node.successCriteria : [node.goal]
}

export function nativeVerificationTarget(state: NativeVerificationOwnedState, node: StoredTaskGraphNode): NativeVerificationTarget | null {
  const task = state.tasks.get(node.taskId)
  if (!task || task.status !== "completed" || task.attemptCount < 1 || task.result === null || task.failureReason !== null) return null
  try {
    const resultText = canonicalNativeVerificationJson(task.result)
    if (Buffer.byteLength(resultText, "utf8") > MAX_RESULT_BYTES) return null
    const resultDigest = digestNativeVerificationValue(task.result)
    return { node, task, attempt: task.attemptCount, goal: node.goal, criteria: nativeVerificationCriteria(node), resultText, resultDigest }
  } catch { return null }
}

export function nativeVerificationBindingDigest(state: NativeVerificationOwnedState, controlHistory: readonly unknown[]): string {
  const bindings = (state.snapshot?.nodes ?? []).map(node => {
    const task = state.tasks.get(node.taskId)!
    let resultDigest: string | null = null
    try { if (task.result !== null) resultDigest = digestNativeVerificationValue(task.result) } catch { /* malformed remains explicitly bound as null */ }
    return {
      nodeId: node.key, taskId: node.taskId, templateId: node.templateId, goal: node.goal, criteria: node.successCriteria,
      dependsOn: node.dependsOn, verificationDisposition: node.verificationDisposition, native: node.nativeDelegation ?? null,
      status: task.status, attempt: task.attemptCount, resultDigest,
      failureReason: task.failureReason, typedReportDigest: typedReportDigest(task.result),
    }
  }).sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  const childReports = controlHistory.filter(value => {
    const item = record(value)
    return item?.targetKind === "child"
  })
  return digestNativeVerificationValue({ bindings, childReports: [...childReports].sort(compareCanonical) })
}

function typedReportDigest(value: unknown): string | null {
  const row = record(value), report = row?.taskGraphVerificationReport
  if (report === undefined) return null
  try { return digestNativeVerificationValue(report) } catch { return null }
}

function compareCanonical(left: unknown, right: unknown): number { return canonicalNativeVerificationJson(left).localeCompare(canonicalNativeVerificationJson(right)) }
