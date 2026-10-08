import { Buffer } from "node:buffer"
import { sha256Hex } from "./context-compaction-canonical.js"
import type { TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"
import { parseSelectedJobMemoryNodes, projectSelectedJobMemoryNodes } from "./selected-job-memory-node-projection.js"
import type { TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import type { SubagentTaskStatus } from "../subagents/types.js"
import type { StepContextSnapshot } from "./step-context-builder.js"

export const SELECTED_JOB_MEMORY_SCHEMA_VERSION = "agent-harness.selected-job-memory.v1" as const
const MAX_RECORDS = 8
const MAX_NODES = 8
const MAX_BYTES = 16 * 1024
const DIGEST = /^[a-f0-9]{64}$/

export type SelectedJobMemoryResult =
  | Readonly<{ availability: "unavailable" }>
  | Readonly<{ availability: "available"; role: "scout"; status: "completed" | "partial"; selectedJobFound: false }>
  | Readonly<{ availability: "available"; role: "scout"; status: "completed" | "partial"; source: "greenhouse" | "lever" | "workday" | "smartrecruiters" | "personio" | "other"; evidenceKinds: readonly ("job" | "persona" | "resume" | "source")[] }>
  | Readonly<{ availability: "available"; role: "analyst"; status: "completed" | "partial"; selectedJobFound: false }>
  | Readonly<{ availability: "available"; role: "analyst"; status: "completed" | "partial"; score: number; evidenceKinds: readonly ("job" | "persona" | "resume" | "source")[] }>
  | Readonly<{ availability: "available"; role: "writer"; status: "completed" }>
  | Readonly<{ availability: "available"; role: "reviewer"; status: "completed"; reviewStatus: "passed" | "needs_revision" | "rejected" | "stale" }>
export type SelectedJobMemoryNode = Readonly<{
  role: "scout" | "analyst" | "writer" | "reviewer"
  status: SubagentTaskStatus
  readiness: "ready" | "waiting_for_dependencies" | "blocked_dependency" | "active" | "terminal"
  verification?: Readonly<{ status: "passed" | "failed" | "unverified"; criteria: readonly Readonly<{ status: "passed" | "failed" | "unverified"; reasonCode: TaskGraphVerificationReasonCode }>[] }>
  repairState: "none" | "pending" | "verified"
  result: SelectedJobMemoryResult
}>
export type SelectedJobMemoryRecord = Readonly<{
  jobId: string; sourceTurnId: string; sourceRootTaskId: string; graphRevision: number
  graphDigest: string; throughSequence: string; schemaVersion: typeof SELECTED_JOB_MEMORY_SCHEMA_VERSION
  nodes: readonly SelectedJobMemoryNode[]
}>

type Row = Record<string, unknown>
function row(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Row : null
}
function exact(value: Row, keys: string): boolean {
  const own = Reflect.ownKeys(value)
  return own.every((key): key is string => typeof key === "string") && own.sort().join(",") === keys
}
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.trim() === value && value.length <= 256 }
function digest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value) }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function recordKey(value: Pick<SelectedJobMemoryRecord, "jobId" | "sourceTurnId" | "sourceRootTaskId">): string { return [value.jobId, value.sourceTurnId, value.sourceRootTaskId].join("\0") }
function digestFor(value: Omit<SelectedJobMemoryRecord, "graphDigest">): string { return sha256Hex(value) }

/** Projects only fixed TaskGraph status, parsed verification and selected-job typed results. */
export function projectSelectedJobMemory(input: {
  readonly jobId: string; readonly sourceTurnId: string; readonly sourceRootTaskId: string; readonly throughSequence: string
  readonly graph: TaskGraphCurrentState | Readonly<{ revision: number; nodes: readonly unknown[] }>
}): SelectedJobMemoryRecord | null {
  if (!text(input.jobId) || !text(input.sourceTurnId) || !text(input.sourceRootTaskId) || !/^(0|[1-9][0-9]*)$/.test(input.throughSequence)
    || !Number.isSafeInteger(input.graph.revision) || input.graph.revision < 1 || !Array.isArray(input.graph.nodes)
    || input.graph.nodes.length < 1 || input.graph.nodes.length > MAX_NODES) return null
  const nodes = projectSelectedJobMemoryNodes({ jobId: input.jobId, graph: input.graph })
  if (!nodes) return null
  const identity = { schemaVersion: SELECTED_JOB_MEMORY_SCHEMA_VERSION, jobId: input.jobId, sourceTurnId: input.sourceTurnId,
    sourceRootTaskId: input.sourceRootTaskId, graphRevision: input.graph.revision, throughSequence: input.throughSequence, nodes }
  const memory: SelectedJobMemoryRecord = { ...identity, graphDigest: digestFor(identity) }
  return Buffer.byteLength(JSON.stringify(memory), "utf8") <= MAX_BYTES ? memory : null
}

export function parseSelectedJobMemories(value: unknown, missingIsEmpty = false): SelectedJobMemoryRecord[] | undefined {
  if (value === undefined && missingIsEmpty) return []
  if (!Array.isArray(value) || value.length > MAX_RECORDS) return undefined
  const records: SelectedJobMemoryRecord[] = []
  for (const entry of value) {
    const item = row(entry)
    if (!item || !exact(item, "graphDigest,graphRevision,jobId,nodes,schemaVersion,sourceRootTaskId,sourceTurnId,throughSequence")
      || item.schemaVersion !== SELECTED_JOB_MEMORY_SCHEMA_VERSION || !text(item.jobId) || !text(item.sourceTurnId) || !text(item.sourceRootTaskId)
      || !Number.isSafeInteger(item.graphRevision) || Number(item.graphRevision) < 1 || !digest(item.graphDigest)
      || typeof item.throughSequence !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.throughSequence)
      || !Array.isArray(item.nodes) || item.nodes.length < 1 || item.nodes.length > MAX_NODES) return undefined
    const typedNodes = parseSelectedJobMemoryNodes(item.nodes)
    if (!typedNodes) return undefined
    const identity = { schemaVersion: SELECTED_JOB_MEMORY_SCHEMA_VERSION, jobId: item.jobId, sourceTurnId: item.sourceTurnId,
      sourceRootTaskId: item.sourceRootTaskId, graphRevision: item.graphRevision as number, throughSequence: item.throughSequence, nodes: typedNodes }
    if (digestFor(identity) !== item.graphDigest) return undefined
    records.push({ ...identity, graphDigest: item.graphDigest })
  }
  if (records.some((value, index) => index > 0 && compare(recordKey(records[index - 1]!), recordKey(value)) >= 0)
    || Buffer.byteLength(JSON.stringify(records), "utf8") > MAX_BYTES) return undefined
  return records
}

export function mergeSelectedJobMemories(previous: readonly SelectedJobMemoryRecord[], current: readonly SelectedJobMemoryRecord[]): SelectedJobMemoryRecord[] {
  const merged = new Map(previous.map(value => [recordKey(value), value]))
  for (const value of current) merged.set(recordKey(value), value)
  const candidates = [...merged.values()].sort((left, right) => {
    const sequence = BigInt(right.throughSequence) - BigInt(left.throughSequence)
    return sequence < 0n ? -1 : sequence > 0n ? 1 : compare(recordKey(left), recordKey(right))
  })
  const selected: SelectedJobMemoryRecord[] = []
  for (const candidate of candidates) {
    if (selected.length >= MAX_RECORDS) break
    if (Buffer.byteLength(JSON.stringify([...selected, candidate]), "utf8") <= MAX_BYTES) selected.push(candidate)
  }
  return selected.sort((left, right) => compare(recordKey(left), recordKey(right)))
}

/** Add informational memory only after the selected-job snapshot filter was applied. */
export function injectSelectedJobMemory(input: {
  readonly snapshot: StepContextSnapshot; readonly records: readonly SelectedJobMemoryRecord[]; readonly jobId?: string
  readonly turnId: string; readonly rootTaskId?: string
}): StepContextSnapshot {
  if (!input.jobId || !input.rootTaskId) return input.snapshot
  const current = input.snapshot.toolObservations.find(item => item.id === "task-graph-current")
  const graph = row(current?.content)
  if (!graph || graph.kind !== "task_graph_current" || !Number.isSafeInteger(graph.revision) || !Array.isArray(graph.nodes)) return input.snapshot
  const records = parseSelectedJobMemories(input.records)
  if (!records) return input.snapshot
  const stored = records.find(value => value.jobId === input.jobId && value.sourceTurnId === input.turnId && value.sourceRootTaskId === input.rootTaskId)
  if (!stored) return input.snapshot
  const fresh = projectSelectedJobMemory({ jobId: input.jobId, sourceTurnId: input.turnId, sourceRootTaskId: input.rootTaskId,
    throughSequence: stored.throughSequence, graph: { revision: graph.revision as number, nodes: graph.nodes } })
  if (!fresh || fresh.graphRevision !== stored.graphRevision || fresh.graphDigest !== stored.graphDigest) return input.snapshot
  const observation = { id: "selected-job-memory", content: { kind: "selected_job_memory", informationalOnly: true,
    schemaVersion: SELECTED_JOB_MEMORY_SCHEMA_VERSION, graphRevision: stored.graphRevision, nodes: stored.nodes } }
  return { ...input.snapshot, toolObservations: [...input.snapshot.toolObservations.filter(item => item.id !== observation.id), observation] }
}
