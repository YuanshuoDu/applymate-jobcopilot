import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import { toRepositoryJson } from "../turns/turn-engine-output.js"
import type { TurnLease } from "../turns/lease.js"
import { projectRootTaskHistoryDiscoveryFootprint } from "./root-task-history-discovery-footprint.js"
import { parseRootTaskHistoryChronologyXid8 } from "./root-task-history-chronology-witness.js"
import type { RootTaskHistoryFence } from "./root-task-history-fence.js"
import type { RootTaskHistorySessionAuthorization } from "./root-task-history-session-memory.js"
import type { RootTaskHistorySteerEvidence } from "./root-task-history-steer-evidence.js"
import type { ContextSeedBlock } from "./step-context-builder.js"

const MAX_NODES = 8
const MAX_CALLS = 64
const MAX_TERMS = 8
const MAX_TEXT = 160
const MAX_BYTES = 4 * 1024
const SNAPSHOT_SCHEMA = "agent-harness.v2.root-task-history-search-footprint-snapshot.v1"
const MAX_SOURCE_TURNS = 2
const ATS_SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio"])
export const ROOT_TASK_HISTORY_SEARCH_FOOTPRINT_OBSERVATION_ID = "root-task-history-search-footprint"

export type RootTaskHistorySearchFootprintContext = Readonly<{
  roles: readonly string[]
  locations: readonly string[]
  atsSources: readonly string[]
}>

/** Ephemeral provenance for ordering validated source graphs; never persisted or emitted. */
export type RootTaskHistorySearchFootprintSource = Readonly<{
  sourceTurnId: string; sourceRootTaskId: string; terminalXid8: string; terminalWitnessEventId: string
  footprint: RootTaskHistorySearchFootprintContext
}>

type Row = Record<string, unknown>

export type RootTaskHistorySearchFootprintSnapshotIdentity = Readonly<{
  schemaVersion: string; sessionId: string; userId: string; searchFootprintReadAllowed: true
  objectiveDigest: string; canonicalOrigin: string; intentKind: string | null; intentVersion: number | null
  acceptedInputRevision: string; steerEvidence: "no_accepted_steer"; startWitnessEventId: string; startWitnessXid8: string
}>

export type RootTaskHistorySearchFootprintSnapshotIdentityInput = Readonly<{
  lease: Pick<TurnLease, "userId" | "sessionId">; authorization: RootTaskHistorySessionAuthorization
  searchFootprintReadAllowed: boolean; fence: RootTaskHistoryFence; acceptedInputRevision: bigint
  steerEvidence: RootTaskHistorySteerEvidence
}>

function row(value: unknown): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Row : undefined
  } catch { return undefined }
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}

function dense(value: unknown, max: number): value is unknown[] {
  try {
    if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      return !!descriptor?.enumerable && "value" in descriptor
    }).every(Boolean)
  } catch { return false }
}

function add(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value) && target.length < MAX_TERMS) target.push(value)
}

function bounded(context: RootTaskHistorySearchFootprintContext): RootTaskHistorySearchFootprintContext | undefined {
  const safe = { roles: [...context.roles], locations: [...context.locations], atsSources: [...context.atsSources] }
  return Buffer.byteLength(JSON.stringify(safe), "utf8") <= MAX_BYTES ? safe : undefined
}

function empty(): RootTaskHistorySearchFootprintContext {
  return { roles: [], locations: [], atsSources: [] }
}

function parseOrigin(value: unknown): { kind: string | null; version: number | null } | undefined {
  if (typeof value !== "string" || value.length > 512 || value.trim() !== value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || JSON.stringify(parsed) !== value || typeof parsed[0] !== "string"
      || !parsed[0] || parsed[0].length > 128 || parsed[0].trim() !== parsed[0]) return undefined
    if (parsed.length === 2 && parsed[1] === "none") return { kind: null, version: null }
    if (parsed.length === 3 && (parsed[1] === "interactive_discovery_shortlist" || parsed[1] === "objective_task_graph_execution")
      && parsed[2] === 1) return { kind: parsed[1], version: 1 }
  } catch { return undefined }
  return undefined
}

export function createRootTaskHistorySearchFootprintSnapshotIdentity(
  input: RootTaskHistorySearchFootprintSnapshotIdentityInput,
): RootTaskHistorySearchFootprintSnapshotIdentity | undefined {
  const { lease, authorization, fence } = input, origin = parseOrigin(fence.currentOrigin), revision = input.acceptedInputRevision
  const witness = fence.currentStartWitness
  if (input.searchFootprintReadAllowed !== true || !lease.userId || !lease.sessionId
    || authorization.userId !== lease.userId || authorization.sessionId !== lease.sessionId
    || !/^[0-9a-f]{64}$/.test(fence.objectiveDigest) || !origin
    || typeof revision !== "bigint" || revision < 0n || revision.toString().length > 128
    || input.steerEvidence.kind !== "no_accepted_steer" || !witness?.eventId || witness.eventId.length > 128 || witness.eventId.trim() !== witness.eventId
    || parseRootTaskHistoryChronologyXid8(witness.xid8) === undefined) return undefined
  return { schemaVersion: SNAPSHOT_SCHEMA, sessionId: lease.sessionId, userId: lease.userId,
    searchFootprintReadAllowed: true, objectiveDigest: fence.objectiveDigest, canonicalOrigin: fence.currentOrigin!,
    intentKind: origin.kind, intentVersion: origin.version, acceptedInputRevision: revision.toString(),
    steerEvidence: "no_accepted_steer", startWitnessEventId: witness.eventId, startWitnessXid8: witness.xid8 }
}

export function rootTaskHistorySearchFootprintSnapshotKey(value: RootTaskHistorySearchFootprintSnapshotIdentity): string {
  const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
  return `root-task-history-search-footprint-snapshot:${value.sessionId}:${digest}:v1`
}

export function createRootTaskHistorySearchFootprintSnapshotPayload(
  identity: RootTaskHistorySearchFootprintSnapshotIdentity, value: unknown,
): RepositoryJsonValue | undefined {
  if (identity.searchFootprintReadAllowed !== true) return undefined
  const searchFootprints = parseRootTaskHistorySearchFootprintContext(value)
  if (!searchFootprints) return undefined
  const payload = { schemaVersion: SNAPSHOT_SCHEMA, searchFootprints }
  return Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_BYTES ? toRepositoryJson(payload) : undefined
}

export function readRootTaskHistorySearchFootprintSnapshotPayload(
  value: unknown, identity: RootTaskHistorySearchFootprintSnapshotIdentity,
): RootTaskHistorySearchFootprintContext | undefined {
  try {
    const input = row(value)
    if (identity.searchFootprintReadAllowed !== true || !input
      || Reflect.ownKeys(input).sort().join(",") !== "schemaVersion,searchFootprints"
      || ownData(input, "schemaVersion") !== SNAPSHOT_SCHEMA
      || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES) return undefined
    return parseRootTaskHistorySearchFootprintContext(ownData(input, "searchFootprints"))
  } catch { return undefined }
}

/** Projects only ordinary, verified Scout criteria into cross-Session planning hints. */
export function projectRootTaskHistorySearchFootprintContext(value: unknown): RootTaskHistorySearchFootprintContext | undefined {
  const graph = row(value), eligibility = graph && ownData(graph, "discoveryTurnEligibility")
  const revision = graph && ownData(graph, "revision")
  if (!graph || eligibility !== "ordinary" || !Number.isSafeInteger(revision) || Number(revision) < 0
    || !dense(graph.nodes, MAX_NODES) || graph.nodes.length < 1) return undefined
  const context = empty()
  let callCount = 0
  for (const node of graph.nodes) {
    const footprint = projectRootTaskHistoryDiscoveryFootprint(node)
    if (footprint?.availability !== "available") continue
    for (const call of footprint.calls) {
      if (++callCount > MAX_CALLS) return undefined
      add(context.roles, call.criteria.targetRoles)
      add(context.locations, call.criteria.targetLocations)
      if (call.criteria.source && ATS_SOURCES.has(call.criteria.source)) add(context.atsSources, [call.criteria.source])
    }
  }
  if (!context.roles.length && !context.locations.length && !context.atsSources.length) return undefined
  return bounded(context)
}

/** Validates the exact persisted/model-visible data shape and its allowlisted values. */
export function parseRootTaskHistorySearchFootprintContext(value: unknown): RootTaskHistorySearchFootprintContext | undefined {
  try {
    const input = row(value)
    if (!input || Reflect.ownKeys(input).sort().join(",") !== "atsSources,locations,roles") return undefined
    const parseTerms = (candidate: unknown, allowlist?: ReadonlySet<string>): string[] | undefined => {
      if (!dense(candidate, MAX_TERMS)) return undefined
      const terms = candidate.map(item => item)
      if (terms.some(item => typeof item !== "string" || !item || item.length > MAX_TEXT || item.trim() !== item
        || /[\u0000-\u001f\u007f]/.test(item) || redactSensitiveText(item) !== item || allowlist && !allowlist.has(item))
        || new Set(terms).size !== terms.length) return undefined
      return terms as string[]
    }
    const roles = parseTerms(ownData(input, "roles")), locations = parseTerms(ownData(input, "locations"))
    const atsSources = parseTerms(ownData(input, "atsSources"), ATS_SOURCES)
    if (!roles || !locations || !atsSources) return undefined
    return bounded({ roles, locations, atsSources })
  } catch { return undefined }
}

/** Combines already-projected entries in caller-supplied newest-first chronology. */
export function mergeRootTaskHistorySearchFootprintContexts(
  values: readonly unknown[],
): RootTaskHistorySearchFootprintContext | undefined {
  if (!dense(values, MAX_SOURCE_TURNS)) return undefined
  const merged = empty()
  for (const value of values) {
    const context = parseRootTaskHistorySearchFootprintContext(value)
    if (!context) return undefined
    add(merged.roles, context.roles)
    add(merged.locations, context.locations)
    add(merged.atsSources, context.atsSources)
  }
  return bounded(merged)
}

/** Revalidates chronology, then discards all provenance before returning the projection. */
export function mergeRootTaskHistorySearchFootprintSources(
  values: readonly unknown[], currentStartXid8: unknown,
): RootTaskHistorySearchFootprintContext | undefined {
  const start = parseRootTaskHistoryChronologyXid8(currentStartXid8)
  if (!start || !dense(values, 64)) return empty()
  const sources: Array<{ xid8: bigint; identity: string; context: RootTaskHistorySearchFootprintContext }> = []
  const seen = new Map<string, string>(), conflicts = new Set<string>()
  for (const value of values) {
    const source = row(value)
    if (!source || Reflect.ownKeys(source).sort().join(",") !== "footprint,sourceRootTaskId,sourceTurnId,terminalWitnessEventId,terminalXid8") continue
    const xid8 = parseRootTaskHistoryChronologyXid8(ownData(source, "terminalXid8"))
    const witness = ownData(source, "terminalWitnessEventId"), turnId = ownData(source, "sourceTurnId")
    const rootId = ownData(source, "sourceRootTaskId"), footprint = ownData(source, "footprint")
    if (!xid8 || xid8 >= start || typeof witness !== "string" || !witness || witness.length > 128 || witness.trim() !== witness
      || typeof turnId !== "string" || !turnId || turnId.length > 256 || turnId.trim() !== turnId
      || typeof rootId !== "string" || !rootId || rootId.length > 256 || rootId.trim() !== rootId) continue
    const context = parseRootTaskHistorySearchFootprintContext(footprint)
    if (!context) continue
    const identity = JSON.stringify([turnId, rootId]), serialized = JSON.stringify([xid8.toString(), witness, context]), prior = seen.get(identity)
    if (conflicts.has(identity)) continue
    if (prior && prior !== serialized) {
      conflicts.add(identity)
      const index = sources.findIndex(item => item.identity === identity)
      if (index >= 0) sources.splice(index, 1)
      continue
    }
    seen.set(identity, serialized)
    if (!prior) sources.push({ xid8, identity, context })
  }
  sources.sort((left, right) => left.xid8 === right.xid8
    ? left.identity < right.identity ? 1 : left.identity > right.identity ? -1 : 0
    : left.xid8 > right.xid8 ? -1 : 1)
  return mergeRootTaskHistorySearchFootprintContexts(sources.slice(0, MAX_SOURCE_TURNS).map(item => item.context)) ?? empty()
}

export function rootTaskHistorySearchFootprintObservation(value: unknown): ContextSeedBlock | undefined {
  const context = parseRootTaskHistorySearchFootprintContext(value)
  if (!context || !context.roles.length && !context.locations.length && !context.atsSources.length) return undefined
  return { id: ROOT_TASK_HISTORY_SEARCH_FOOTPRINT_OBSERVATION_ID, content: {
    kind: "root_task_history_search_footprint", historical: true, informationalOnly: true,
    advisoryOnly: true, notCurrentEvidence: true, ...context,
  } }
}
