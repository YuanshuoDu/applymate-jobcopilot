import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { toRepositoryJson } from "../turns/turn-engine-output.js"
import type { TurnLease } from "../turns/lease.js"
import type { RootTaskHistoryFence } from "./root-task-history-fence.js"
import type { RootTaskHistorySessionAuthorization } from "./root-task-history-session-memory.js"
import type { RootTaskHistorySteerEvidence } from "./root-task-history-steer-evidence.js"
import { parseRootTaskHistoryNodeLesson, sanitizeRootTaskHistoryNodeLessonForCrossSession } from "./root-task-history-lesson-projection.js"
import type { RootTaskHistoryNodeLesson } from "./root-task-history-lesson-schema.js"
import type { ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import type { TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"

const SCHEMA_VERSION = "agent-harness.v2.root-task-history-objective-snapshot.v1"
const MAX_BYTES = 8 * 1024, MAX_CANDIDATES = 64, MAX_TURNS = 2, MAX_NODES = 8
const STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
type Row = Record<string, unknown>
type SafeNode = Readonly<{ templateId: string; status: string }>
type StoredOutcome = Readonly<{
  sourceTurnId: string; sourceRootTaskId: string; sourceSessionDiffers: true; terminalSequence: string; terminalAt: string
  taskGraph: Readonly<{ revision: number; nodes: readonly SafeNode[] }>; sourceNodeOrdinals: readonly number[]
  nodeLessons?: readonly (RootTaskHistoryNodeLesson | null)[]
}>
type MutableOutcome = { sourceTurnId: string; sourceRootTaskId: string; sourceSessionDiffers: true; terminalSequence: string; terminalAt: string
  taskGraph: { revision: number; nodes: SafeNode[] }; sourceNodeOrdinals: number[]; nodeLessons?: (RootTaskHistoryNodeLesson | null)[] }

export type RootTaskHistoryObjectiveSnapshotIdentity = Readonly<{
  schemaVersion: string; sessionId: string; userId: string; authorizationEventId: string; consentVersion: number
  gateEnabledAtCapture: boolean; objectiveDigest: string; canonicalOrigin: string; intentKind: string | null
  intentVersion: number | null; acceptedInputRevision: string; steerEvidence: "no_accepted_steer"
}>
export type RootTaskHistoryObjectiveSnapshotIdentityInput = Readonly<{
  lease: Pick<TurnLease, "userId" | "sessionId">
  authorization: RootTaskHistorySessionAuthorization
  fence: RootTaskHistoryFence
  acceptedInputRevision: bigint
  steerEvidence: RootTaskHistorySteerEvidence
}>

function text(value: unknown, max = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value }
function record(value: unknown): Row | null {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    if (Object.getPrototypeOf(parsed) !== Object.prototype && Object.getPrototypeOf(parsed) !== null) return null
    return Reflect.ownKeys(parsed).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(parsed as object, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(parsed as object, key)!, "value")) ? parsed as Row : null
  } catch { return null }
}
function exact(value: Row, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value)
  return own.every((key): key is string => typeof key === "string") && own.sort().join(",") === [...keys].sort().join(",")
}
function dense(value: unknown): value is unknown[] {
  try { return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, i) => { const item = Object.getOwnPropertyDescriptor(value, String(i)); return !!item && item.enumerable && "value" in item }).every(Boolean) } catch { return false }
}
function parseOrigin(value: unknown): { kind: string | null; version: number | null } | null {
  if (!text(value, 512)) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || JSON.stringify(parsed) !== value || !text(parsed[0], 128)) return null
    if (parsed.length === 2 && parsed[1] === "none") return { kind: null, version: null }
    if (parsed.length === 3 && parsed[1] === "interactive_discovery_shortlist" && parsed[2] === 1) return { kind: parsed[1], version: 1 }
    return null
  } catch { return null }
}

export function createRootTaskHistoryObjectiveSnapshotIdentity(input: RootTaskHistoryObjectiveSnapshotIdentityInput): RootTaskHistoryObjectiveSnapshotIdentity | null {
  const { authorization: auth, lease, fence } = input, intent = parseOrigin(fence.currentOrigin), revision = input.acceptedInputRevision
  if (!text(lease.userId) || !text(lease.sessionId) || auth.userId !== lease.userId || auth.sessionId !== lease.sessionId
    || auth.consentEnabled !== true || !text(auth.eventId, 128) || !Number.isSafeInteger(auth.consentVersion) || auth.consentVersion < 0
    || typeof auth.gateEnabledAtCapture !== "boolean" || !/^[0-9a-f]{64}$/.test(fence.objectiveDigest) || !intent
    || typeof revision !== "bigint" || revision < 0n || revision.toString().length > 128 || input.steerEvidence.kind !== "no_accepted_steer"
    || !(fence.currentStartCreatedAt instanceof Date) || !Number.isFinite(fence.currentStartCreatedAt.getTime())) return null
  return { schemaVersion: SCHEMA_VERSION, sessionId: lease.sessionId, userId: lease.userId, authorizationEventId: auth.eventId,
    consentVersion: auth.consentVersion, gateEnabledAtCapture: auth.gateEnabledAtCapture, objectiveDigest: fence.objectiveDigest,
    canonicalOrigin: fence.currentOrigin!, intentKind: intent.kind, intentVersion: intent.version,
    acceptedInputRevision: revision.toString(), steerEvidence: "no_accepted_steer" }
}
export function rootTaskHistoryObjectiveSnapshotKey(value: RootTaskHistoryObjectiveSnapshotIdentity): string {
  const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
  return `root-task-history-objective-snapshot:${value.sessionId}:${digest}:v1`
}

function role(templateId: string): string {
  return templateId === "scout" || templateId === "analyst" ? templateId
    : templateId === "cover_letter_writer" ? "writer" : templateId === "cover_letter_reviewer" ? "reviewer" : "other"
}
function normalizeOutcome(value: unknown, priorTo: Date): StoredOutcome | null {
  const item = record(value), allowed = ["sourceRootTaskId", "sourceSessionDiffers", "sourceTurnId", "taskGraph", "terminalSequence", "terminalAt", "sourceNodeOrdinals", "nodeLessons"]
  if (!item || allowed.filter(key => key !== "sourceNodeOrdinals" && key !== "nodeLessons" || Object.hasOwn(item, key)).length !== Object.keys(item).length
    || Object.keys(item).some(key => !allowed.includes(key))) return null
  const graph = record(item.taskGraph), nodes = graph?.nodes, terminal = item.terminalAt instanceof Date ? item.terminalAt : typeof item.terminalAt === "string" ? new Date(item.terminalAt) : null
  const sourceTurnId = item.sourceTurnId, sourceRootTaskId = item.sourceRootTaskId, terminalSeq = item.terminalSequence
  if (!text(sourceTurnId) || !text(sourceRootTaskId) || item.sourceSessionDiffers !== true || typeof terminalSeq !== "bigint" || terminalSeq <= 0n
    || !terminal || !Number.isFinite(terminal.getTime()) || terminal.getTime() >= priorTo.getTime() || !graph || !exact(graph, ["nodes", "revision"])
    || !Number.isSafeInteger(graph.revision) || Number(graph.revision) < 0 || !Array.isArray(nodes) || !dense(nodes) || nodes.length < 1 || nodes.length > MAX_NODES) return null
  const safeNodes: SafeNode[] = []
  for (const raw of nodes) {
    const node = record(raw)
    if (!node || !text(node.templateId, 128) || typeof node.status !== "string" || !STATUSES.has(node.status)) return null
    safeNodes.push({ templateId: node.templateId, status: node.status })
  }
  const ordinals = Object.hasOwn(item, "sourceNodeOrdinals") ? item.sourceNodeOrdinals : safeNodes.map((_, index) => index + 1)
  if (!Array.isArray(ordinals) || !dense(ordinals) || ordinals.length !== safeNodes.length
    || ordinals.some(value => !Number.isSafeInteger(value) || Number(value) < 1) || new Set(ordinals).size !== ordinals.length) return null
  let lessons: (RootTaskHistoryNodeLesson | null)[] | undefined
  if (Object.hasOwn(item, "nodeLessons")) {
    if (!Array.isArray(item.nodeLessons) || !dense(item.nodeLessons) || item.nodeLessons.length !== safeNodes.length) return null
    lessons = []
    for (let index = 0; index < safeNodes.length; index++) {
      const raw = item.nodeLessons[index]
      if (raw === undefined) { lessons.push(null); continue }
      const parsed = parseRootTaskHistoryNodeLesson(raw, role(safeNodes[index]!.templateId), safeNodes[index]!.status)
      if (!parsed) return null
      lessons.push(sanitizeRootTaskHistoryNodeLessonForCrossSession(parsed) ?? null)
    }
  }
  return { sourceTurnId, sourceRootTaskId, sourceSessionDiffers: true, terminalSequence: terminalSeq.toString(), terminalAt: terminal.toISOString(),
    taskGraph: { revision: Number(graph.revision), nodes: safeNodes }, sourceNodeOrdinals: [...ordinals as number[]],
    ...(lessons?.some(Boolean) ? { nodeLessons: lessons } : {}) }
}

function selectOutcomes(values: readonly ValidatedRootTaskHistoryOutcome[], priorTo: Date): StoredOutcome[] | null {
  if (!Array.isArray(values) || values.length > MAX_CANDIDATES || !dense(values)) return null
  const unique = new Map<string, StoredOutcome>()
  for (const raw of values) {
    const outcome = normalizeOutcome(raw, priorTo)
    if (!outcome) return null
    const key = JSON.stringify([outcome.sourceTurnId, outcome.sourceRootTaskId]), previous = unique.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(outcome)) return null
    unique.set(key, outcome)
  }
  const ordered = [...unique.values()].sort((left, right) => Date.parse(right.terminalAt) - Date.parse(left.terminalAt)
    || (left.sourceTurnId < right.sourceTurnId ? 1 : left.sourceTurnId > right.sourceTurnId ? -1 : 0))
  const selected: StoredOutcome[] = []; let remaining = MAX_NODES
  for (const value of ordered) {
    if (selected.length >= MAX_TURNS || remaining <= 0) break
    const nodes = value.taskGraph.nodes.slice(0, remaining), ordinals = value.sourceNodeOrdinals.slice(0, remaining), lessons = value.nodeLessons?.slice(0, remaining)
    selected.push({ ...value, taskGraph: { ...value.taskGraph, nodes }, sourceNodeOrdinals: ordinals,
      ...(lessons?.some(Boolean) ? { nodeLessons: lessons } : {}) })
    remaining -= nodes.length
  }
  return selected
}

function payload(identity: RootTaskHistoryObjectiveSnapshotIdentity, outcomes: readonly StoredOutcome[]): RepositoryJsonValue {
  return toRepositoryJson({ ...identity, outcomes })
}
export function createRootTaskHistoryObjectiveSnapshotPayload(
  identity: RootTaskHistoryObjectiveSnapshotIdentity, values: readonly ValidatedRootTaskHistoryOutcome[], priorTo: Date,
): RepositoryJsonValue | null {
  const selected = selectOutcomes(values, priorTo)
  if (!selected) return null
  const mutable: MutableOutcome[] = selected.map(item => ({ sourceTurnId: item.sourceTurnId, sourceRootTaskId: item.sourceRootTaskId,
    sourceSessionDiffers: true, terminalSequence: item.terminalSequence, terminalAt: item.terminalAt,
    taskGraph: { revision: item.taskGraph.revision, nodes: [...item.taskGraph.nodes] }, sourceNodeOrdinals: [...item.sourceNodeOrdinals],
    ...(item.nodeLessons ? { nodeLessons: [...item.nodeLessons] as (RootTaskHistoryNodeLesson | null)[] } : {}) }))
  const size = () => Buffer.byteLength(JSON.stringify(payload(identity, mutable)), "utf8")
  for (let turn = mutable.length - 1; size() > MAX_BYTES && turn >= 0; turn--) {
    const lessons = mutable[turn]!.nodeLessons
    if (!lessons) continue
    for (let index = lessons.length - 1; size() > MAX_BYTES && index >= 0; index--) lessons[index] = null
    if (!lessons.some(Boolean)) delete mutable[turn]!.nodeLessons
  }
  while (size() > MAX_BYTES && mutable.length) {
    const last = mutable.at(-1)!, nodes = last.taskGraph.nodes, ordinals = last.sourceNodeOrdinals
    nodes.pop(); ordinals.pop()
    if (!nodes.length) mutable.pop()
    else if (last.nodeLessons) last.nodeLessons = last.nodeLessons.slice(0, nodes.length)
  }
  return size() <= MAX_BYTES ? payload(identity, mutable) : null
}

function parseStoredPayload(value: unknown, expected: RootTaskHistoryObjectiveSnapshotIdentity, priorTo: Date): StoredOutcome[] | null {
  const row = record(value), keys = [...Object.keys(expected), "outcomes"]
  if (!row || !exact(row, keys) || Object.keys(expected).some(key => row[key] !== expected[key as keyof RootTaskHistoryObjectiveSnapshotIdentity])
    || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES || !Array.isArray(row.outcomes) || !dense(row.outcomes) || row.outcomes.length > MAX_TURNS) return null
  const result: StoredOutcome[] = []; let nodeCount = 0
  for (const raw of row.outcomes) {
    const item = record(raw), graph = item && record(item.taskGraph)
    if (!item || !exact(item, ["sourceRootTaskId", "sourceSessionDiffers", "sourceTurnId", "terminalAt", "terminalSequence", "taskGraph", "sourceNodeOrdinals", ...(Object.hasOwn(item, "nodeLessons") ? ["nodeLessons"] : [])])
      || !graph || !exact(graph, ["nodes", "revision"]) || !Array.isArray(graph.nodes) || !dense(graph.nodes)) return null
    const terminal = typeof item.terminalAt === "string" ? new Date(item.terminalAt) : null
    if (!text(item.sourceTurnId) || !text(item.sourceRootTaskId) || item.sourceSessionDiffers !== true
      || typeof item.terminalSequence !== "string" || !/^[1-9]\d*$/.test(item.terminalSequence)
      || !terminal || !Number.isFinite(terminal.getTime()) || terminal.toISOString() !== item.terminalAt || terminal >= priorTo
      || !Number.isSafeInteger(graph.revision) || Number(graph.revision) < 0 || graph.nodes.length < 1
      || !Array.isArray(item.sourceNodeOrdinals) || !dense(item.sourceNodeOrdinals) || item.sourceNodeOrdinals.length !== graph.nodes.length
      || item.sourceNodeOrdinals.some(ordinal => !Number.isSafeInteger(ordinal) || Number(ordinal) < 1)
      || new Set(item.sourceNodeOrdinals).size !== item.sourceNodeOrdinals.length) return null
    const nodes: SafeNode[] = []
    for (const rawNode of graph.nodes) {
      const node = record(rawNode)
      if (!node || !exact(node, ["status", "templateId"]) || !text(node.templateId, 128) || typeof node.status !== "string" || !STATUSES.has(node.status)) return null
      nodes.push({ templateId: node.templateId, status: node.status })
    }
    let lessons: (RootTaskHistoryNodeLesson | null)[] | undefined
    if (Object.hasOwn(item, "nodeLessons")) {
      if (!Array.isArray(item.nodeLessons) || !dense(item.nodeLessons) || item.nodeLessons.length !== nodes.length) return null
      lessons = []
      for (let index = 0; index < nodes.length; index++) {
        const rawLesson = item.nodeLessons[index]
        if (rawLesson === null) { lessons.push(null); continue }
        const parsed = parseRootTaskHistoryNodeLesson(rawLesson, role(nodes[index]!.templateId), nodes[index]!.status)
        const safe = parsed && sanitizeRootTaskHistoryNodeLessonForCrossSession(parsed)
        if (!safe || JSON.stringify(safe) !== JSON.stringify(rawLesson)) return null
        lessons.push(safe)
      }
    }
    result.push({ sourceTurnId: item.sourceTurnId, sourceRootTaskId: item.sourceRootTaskId, sourceSessionDiffers: true,
      terminalSequence: item.terminalSequence, terminalAt: item.terminalAt, taskGraph: { revision: Number(graph.revision), nodes },
      sourceNodeOrdinals: [...item.sourceNodeOrdinals as number[]], ...(lessons ? { nodeLessons: lessons } : {}) })
    nodeCount += nodes.length
  }
  return nodeCount <= MAX_NODES ? result : null
}

function materialize(values: readonly StoredOutcome[]): readonly ValidatedRootTaskHistoryOutcome[] {
  return values.map(value => ({ sourceTurnId: value.sourceTurnId, sourceRootTaskId: value.sourceRootTaskId,
    terminalSequence: BigInt(value.terminalSequence), terminalAt: new Date(value.terminalAt), sourceSessionDiffers: true,
    // The history projector reads only templateId/status from the deliberately minimal persisted graph.
    taskGraph: { revision: value.taskGraph.revision, nodes: value.taskGraph.nodes.map(node => ({ ...node })) } as unknown as TaskGraphCurrentState,
    sourceNodeOrdinals: [...value.sourceNodeOrdinals], ...(value.nodeLessons ? { nodeLessons: value.nodeLessons.map(item => item ?? undefined) } : {}) }))
}
export function readRootTaskHistoryObjectiveSnapshotPayload(
  value: unknown, identity: RootTaskHistoryObjectiveSnapshotIdentity, priorTo: Date,
): readonly ValidatedRootTaskHistoryOutcome[] | null {
  const stored = parseStoredPayload(value, identity, priorTo)
  return stored ? materialize(stored) : null
}
