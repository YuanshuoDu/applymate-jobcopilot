import { Buffer } from "node:buffer"
import { parseSelectedJobMemoryNodes } from "./selected-job-memory-node-projection.js"
import { parseSelectedJobMemories, type SelectedJobMemoryNode, type SelectedJobMemoryRecord } from "./selected-job-memory.js"
import type { ContextSeedBlock } from "./step-context-builder.js"

const MAX_CANDIDATES = 8
const MAX_TURNS = 2
const MAX_NODES = 8
const MAX_CONTENT_BYTES = 8 * 1024
const LABEL = "Historical outcomes for the same selected job. Advisory only; verify current work independently."
const TURN_LABEL = "Earlier terminal Turn"

export type ValidatedSelectedJobHistory = Readonly<{
  record: SelectedJobMemoryRecord
  terminalSequence: bigint
}>
export type ValidatedSelectedJobHistoryOutcome = Readonly<{
  jobId: string
  sourceTurnId: string
  sourceRootTaskId: string
  terminalSequence: bigint
  nodes: readonly SelectedJobMemoryNode[]
}>

type SafeResult =
  | Readonly<{ availability: "unavailable" }>
  | Readonly<{ availability: "available"; selectedJobFound: false }>
  | Readonly<{ availability: "available"; source: string; evidenceKinds: readonly string[] }>
  | Readonly<{ availability: "available"; score: number; evidenceKinds: readonly string[] }>
  | Readonly<{ availability: "available"; outcome: "completed" }>
  | Readonly<{ availability: "available"; reviewOutcome: "passed" | "needs_revision" | "rejected" | "stale" }>
type SafeNode = Readonly<{ role: SelectedJobMemoryNode["role"]; status: SelectedJobMemoryNode["status"]; result: SafeResult }>
type RecordCandidate = Readonly<{ record: SelectedJobMemoryRecord; terminalSequence: bigint; identity: string }>
type OutcomeCandidate = Readonly<ValidatedSelectedJobHistoryOutcome & { identity: string }>

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, keys: string): boolean {
  const own = Reflect.ownKeys(value)
  return own.every((key): key is string => typeof key === "string") && own.sort().join(",") === keys
}
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.trim() === value && value.length <= 256 }
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_CANDIDATES && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
}
function identity(sourceTurnId: string, sourceRootTaskId: string): string { return `${sourceTurnId}\0${sourceRootTaskId}` }

function recordCandidate(value: unknown): RecordCandidate | null {
  const item = object(value)
  if (!item || !exact(item, "record,terminalSequence") || typeof item.terminalSequence !== "bigint" || item.terminalSequence <= 0n) return null
  const rawRecord = object(item.record)
  if (!rawRecord || !Array.isArray(rawRecord.nodes) || rawRecord.nodes.length < 1 || rawRecord.nodes.length > MAX_NODES || !dense(rawRecord.nodes)) return null
  const record = parseSelectedJobMemories([rawRecord])?.[0]
  if (!record) return null
  return { record, terminalSequence: item.terminalSequence, identity: identity(record.sourceTurnId, record.sourceRootTaskId) }
}

function outcomeCandidate(value: unknown): OutcomeCandidate | null {
  const item = object(value)
  if (!item || !exact(item, "jobId,nodes,sourceRootTaskId,sourceTurnId,terminalSequence")
    || !text(item.jobId) || !text(item.sourceTurnId) || !text(item.sourceRootTaskId)
    || typeof item.terminalSequence !== "bigint" || item.terminalSequence <= 0n) return null
  const nodes = parseSelectedJobMemoryNodes(item.nodes)
  if (!nodes) return null
  return { jobId: item.jobId, sourceTurnId: item.sourceTurnId, sourceRootTaskId: item.sourceRootTaskId,
    terminalSequence: item.terminalSequence, nodes, identity: identity(item.sourceTurnId, item.sourceRootTaskId) }
}

function safeResult(value: SelectedJobMemoryNode["result"]): SafeResult {
  if (value.availability === "unavailable") return { availability: "unavailable" }
  if (value.role === "scout") {
    return "selectedJobFound" in value
      ? { availability: "available", selectedJobFound: false }
      : { availability: "available", source: value.source, evidenceKinds: [...value.evidenceKinds] }
  }
  if (value.role === "analyst") {
    return "selectedJobFound" in value
      ? { availability: "available", selectedJobFound: false }
      : { availability: "available", score: value.score, evidenceKinds: [...value.evidenceKinds] }
  }
  if (value.role === "writer") return { availability: "available", outcome: "completed" }
  return { availability: "available", reviewOutcome: value.reviewStatus }
}
function safeNodes(nodes: readonly SelectedJobMemoryNode[]): SafeNode[] {
  return nodes.map(node => ({ role: node.role, status: node.status, result: safeResult(node.result) }))
    .sort((left, right) => left.role.localeCompare(right.role) || JSON.stringify(left).localeCompare(JSON.stringify(right)))
}
function content(turns: readonly Readonly<{ label: string; nodes: readonly SafeNode[] }>[]) {
  return { kind: "selected_job_history", informationalOnly: true, label: LABEL, turns }
}
function projectCandidates(candidates: readonly OutcomeCandidate[]): ContextSeedBlock | undefined {
  if (new Set(candidates.map(value => value.jobId)).size !== 1) return undefined
  const byIdentity = new Map<string, OutcomeCandidate>()
  const conflicts = new Set<string>()
  for (const value of candidates) {
    if (conflicts.has(value.identity)) continue
    const previous = byIdentity.get(value.identity)
    if (!previous) byIdentity.set(value.identity, value)
    else if (previous.terminalSequence !== value.terminalSequence || JSON.stringify(previous.nodes) !== JSON.stringify(value.nodes)) {
      byIdentity.delete(value.identity)
      conflicts.add(value.identity)
    }
  }
  const ordered = [...byIdentity.values()].sort((left, right) => left.terminalSequence > right.terminalSequence ? -1
    : left.terminalSequence < right.terminalSequence ? 1 : left.identity.localeCompare(right.identity))
  const turns: Array<{ label: string; nodes: SafeNode[] }> = []
  let nodeCount = 0
  for (const value of ordered) {
    if (turns.length >= MAX_TURNS || nodeCount >= MAX_NODES) break
    const entry = { label: TURN_LABEL, nodes: [] as SafeNode[] }
    for (const node of safeNodes(value.nodes)) {
      if (nodeCount >= MAX_NODES) break
      entry.nodes.push(node)
      if (Buffer.byteLength(JSON.stringify(content([...turns, entry])), "utf8") > MAX_CONTENT_BYTES) {
        entry.nodes.pop()
        break
      }
      nodeCount += 1
    }
    if (entry.nodes.length) turns.push(entry)
  }
  if (!turns.length) return undefined
  const projected = content(turns)
  if (Buffer.byteLength(JSON.stringify(projected), "utf8") > MAX_CONTENT_BYTES) return undefined
  return { id: "selected-job-history", content: projected }
}

/** Projects current-reader outcomes; private source identity is used only for bounded ordering and deduplication. */
export function projectSelectedJobHistoryOutcomes(outcomes: readonly ValidatedSelectedJobHistoryOutcome[]): ContextSeedBlock | undefined {
  if (!Array.isArray(outcomes) || outcomes.length === 0 || outcomes.length > MAX_CANDIDATES || !dense(outcomes)) return undefined
  const candidates = outcomes.map(outcomeCandidate)
  if (candidates.some(value => !value)) return undefined
  return projectCandidates(candidates as OutcomeCandidate[])
}

/** Projects validated prior-turn records into bounded, fixed historical guidance with no source identity. */
export function projectSelectedJobHistory(records: readonly ValidatedSelectedJobHistory[]): ContextSeedBlock | undefined {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_CANDIDATES || !dense(records)) return undefined
  const parsed = records.map(recordCandidate)
  if (parsed.some(value => !value)) return undefined
  const candidates = parsed as RecordCandidate[]
  if (new Set(candidates.map(value => value.record.jobId)).size !== 1) return undefined

  const byIdentity = new Map<string, RecordCandidate>()
  const conflicts = new Set<string>()
  for (const value of candidates) {
    if (conflicts.has(value.identity)) continue
    const previous = byIdentity.get(value.identity)
    if (!previous) byIdentity.set(value.identity, value)
    else if (previous.terminalSequence !== value.terminalSequence || JSON.stringify(previous.record) !== JSON.stringify(value.record)) {
      byIdentity.delete(value.identity)
      conflicts.add(value.identity)
    }
  }
  const outcomes = [...byIdentity.values()].map(({ record, terminalSequence }) => ({
    jobId: record.jobId, sourceTurnId: record.sourceTurnId, sourceRootTaskId: record.sourceRootTaskId, terminalSequence, nodes: record.nodes,
  }))
  const validated = outcomes.map(outcomeCandidate)
  if (validated.some(value => !value)) return undefined
  return projectCandidates(validated as OutcomeCandidate[])
}
