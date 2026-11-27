import { Buffer } from "node:buffer"
import type { TaskGraphVerificationDependencyBinding } from "./task-graph-verification-report.js"

const LEGACY_BINDING_VERSION = "agent-harness.v2.scheduled-draft-candidate-binding.v1" as const
const V2_BINDING_VERSION = 2 as const
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MATERIAL_DIGEST = /^sha256:[a-f0-9]{64}$/
const MAX_ANALYSTS = 8

export type ScheduledDraftCandidate = Readonly<{ jobId: string; score: number }>
type AnalystBinding = Readonly<{ nodeKey: string; taskId: string; attemptCount: number; resultDigest: string; evidenceDigest: string;
  reportDigest: string; scouts: readonly TaskGraphVerificationDependencyBinding[] }>
type WitnessCore = Readonly<{ graphRevision: number; graphDigest: string; stableStatusDigest: string;
  lifecycleStatuses?: Readonly<{ writer: string; reviewer: string }>; newlyProposedNodeKeys: readonly string[];
  candidate: ScheduledDraftCandidate; sourceAnalystKeys: readonly string[]; analysts: readonly AnalystBinding[] }>
export type ScheduledDraftCandidateWitnessV1 = WitnessCore & Readonly<{ bindingVersion: typeof LEGACY_BINDING_VERSION }>
export type ScheduledDraftCandidateWitnessV2 = WitnessCore & Readonly<{ bindingVersion: typeof V2_BINDING_VERSION; jobMaterialDigest: string }>
export type ScheduledDraftCandidateWitness = ScheduledDraftCandidateWitnessV1 | ScheduledDraftCandidateWitnessV2

export function makeScheduledDraftCandidateWitnessV2(input: WitnessCore & Readonly<{ jobMaterialDigest: string }>): ScheduledDraftCandidateWitnessV2 {
  return { bindingVersion: V2_BINDING_VERSION, graphRevision: input.graphRevision, graphDigest: input.graphDigest,
    stableStatusDigest: input.stableStatusDigest, ...(input.lifecycleStatuses ? { lifecycleStatuses: input.lifecycleStatuses } : {}),
    newlyProposedNodeKeys: [...input.newlyProposedNodeKeys], candidate: input.candidate,
    sourceAnalystKeys: [...input.sourceAnalystKeys], analysts: sortedAnalysts(input.analysts), jobMaterialDigest: input.jobMaterialDigest }
}

/** Accept old witnesses only as persisted continuations; new selection only calls the V2 builder. */
export function parseScheduledDraftCandidateWitness(value: unknown): ScheduledDraftCandidateWitness | undefined {
  const row = record(value), version = row?.bindingVersion
  if (!row || (version !== LEGACY_BINDING_VERSION && version !== V2_BINDING_VERSION)) return undefined
  const expected = version === LEGACY_BINDING_VERSION
    ? "analysts,bindingVersion,candidate,graphDigest,graphRevision,lifecycleStatuses,newlyProposedNodeKeys,sourceAnalystKeys,stableStatusDigest"
    : "analysts,bindingVersion,candidate,graphDigest,graphRevision,jobMaterialDigest,lifecycleStatuses,newlyProposedNodeKeys,sourceAnalystKeys,stableStatusDigest"
  const required = version === LEGACY_BINDING_VERSION
    ? "analysts,bindingVersion,candidate,graphDigest,graphRevision,newlyProposedNodeKeys,sourceAnalystKeys,stableStatusDigest"
    : "analysts,bindingVersion,candidate,graphDigest,graphRevision,jobMaterialDigest,newlyProposedNodeKeys,sourceAnalystKeys,stableStatusDigest"
  if (!exactKeySet(row, expected, required)) return undefined
  const candidate = parseCandidate(row.candidate), proposed = row.newlyProposedNodeKeys
  if (!candidate || !validRevision(row.graphRevision) || !isSha(row.graphDigest) || !isSha(row.stableStatusDigest)
    || version === V2_BINDING_VERSION && !isMaterialDigest(row.jobMaterialDigest)
    || !dense(row.analysts, MAX_ANALYSTS) || !row.analysts.length || !dense(row.sourceAnalystKeys, MAX_ANALYSTS) || !row.sourceAnalystKeys.length
    || !dense(proposed, 8) || !proposed.every((key, index) => canonicalId(key) && (index === 0 || compare(proposed[index - 1], key) < 0))) return undefined
  const analysts: AnalystBinding[] = []
  for (const entry of row.analysts) {
    const item = exactRecord(entry, "attemptCount,evidenceDigest,nodeKey,reportDigest,resultDigest,scouts,taskId")
    if (!item || !canonicalId(item.nodeKey) || !canonicalId(item.taskId) || !validAttempt(item.attemptCount)
      || !isSha(item.resultDigest) || !isSha(item.evidenceDigest) || !isSha(item.reportDigest)
      || !dense(item.scouts, MAX_ANALYSTS) || !item.scouts.length) return undefined
    const scouts = item.scouts.map(parseTaskBinding)
    if (scouts.some(binding => !binding) || !scouts.every((binding, index) => index === 0 || compare(scouts[index - 1]!.nodeKey, binding!.nodeKey) < 0)) return undefined
    analysts.push({ nodeKey: item.nodeKey, taskId: item.taskId, attemptCount: item.attemptCount, resultDigest: item.resultDigest,
      evidenceDigest: item.evidenceDigest, reportDigest: item.reportDigest, scouts: scouts as TaskGraphVerificationDependencyBinding[] })
  }
  if (!analysts.every((item, index) => index === 0 || compare(analysts[index - 1]!.nodeKey, item.nodeKey) < 0)) return undefined
  const sourceAnalystKeys = row.sourceAnalystKeys
  if (!sourceAnalystKeys.every(canonicalId) || sourceAnalystKeys.some((key, index) => index > 0 && compare(sourceAnalystKeys[index - 1], key) >= 0)
    || sourceAnalystKeys.some(key => !analysts.some(item => item.nodeKey === key))) return undefined
  const lifecycle = row.lifecycleStatuses === undefined ? undefined : parseLifecycle(row.lifecycleStatuses)
  if (row.lifecycleStatuses !== undefined && !lifecycle) return undefined
  const newlyProposedNodeKeys = proposed as string[]
  if (analysts.some(item => newlyProposedNodeKeys.includes(item.nodeKey) || item.scouts.some(scout => newlyProposedNodeKeys.includes(scout.nodeKey)))) return undefined
  const core: WitnessCore = { graphRevision: row.graphRevision, graphDigest: row.graphDigest, stableStatusDigest: row.stableStatusDigest,
    ...(lifecycle ? { lifecycleStatuses: lifecycle } : {}), newlyProposedNodeKeys, candidate, sourceAnalystKeys: sourceAnalystKeys as string[], analysts }
  return version === LEGACY_BINDING_VERSION
    ? { bindingVersion: LEGACY_BINDING_VERSION, ...core }
    : { bindingVersion: V2_BINDING_VERSION, ...core, jobMaterialDigest: row.jobMaterialDigest as string }
}

export function legacyWitnessMatches(witness: ScheduledDraftCandidateWitnessV1, input: WitnessCore): boolean {
  const normalized = { bindingVersion: LEGACY_BINDING_VERSION, ...input,
    ...(input.lifecycleStatuses ? { lifecycleStatuses: input.lifecycleStatuses } : {}),
    newlyProposedNodeKeys: [...input.newlyProposedNodeKeys], sourceAnalystKeys: [...input.sourceAnalystKeys], analysts: sortedAnalysts(input.analysts) }
  return canonicalJson(normalized) === canonicalJson(witness)
}

function sortedAnalysts(values: readonly AnalystBinding[]): AnalystBinding[] {
  return [...values].sort((a, b) => compare(a.nodeKey, b.nodeKey)).map(item => ({ ...item, scouts: [...item.scouts].sort((a, b) => compare(a.nodeKey, b.nodeKey)) }))
}
function parseCandidate(value: unknown): ScheduledDraftCandidate | undefined {
  const row = exactRecord(value, "jobId,score")
  return row && canonicalId(row.jobId) && typeof row.score === "number" && Number.isFinite(row.score) && row.score >= 0 && row.score <= 10
    ? { jobId: row.jobId, score: row.score } : undefined
}
function parseTaskBinding(value: unknown): TaskGraphVerificationDependencyBinding | undefined {
  const row = exactRecord(value, "attemptCount,evidenceDigest,nodeDigest,nodeKey,reportDigest,resultDigest,taskId")
  return row && canonicalId(row.nodeKey) && canonicalId(row.taskId) && validAttempt(row.attemptCount) && isSha(row.nodeDigest)
    && isSha(row.resultDigest) && isSha(row.evidenceDigest) && isSha(row.reportDigest)
    ? { nodeKey: row.nodeKey, taskId: row.taskId, attemptCount: row.attemptCount, nodeDigest: row.nodeDigest,
      resultDigest: row.resultDigest, evidenceDigest: row.evidenceDigest, reportDigest: row.reportDigest } : undefined
}
function parseLifecycle(value: unknown): Readonly<{ writer: string; reviewer: string }> | undefined {
  const row = exactRecord(value, "reviewer,writer")
  return row && validStatus(row.writer) && validStatus(row.reviewer) ? { writer: row.writer, reviewer: row.reviewer } : undefined
}
function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  const row = record(value)
  return row && exactKeySet(row, keys, keys) ? row : undefined
}
function exactKeySet(row: Record<string, unknown>, withOptional: string, required: string): boolean {
  const keys = Reflect.ownKeys(row), allowed = new Set(withOptional.split(",")), requiredKeys = required.split(",")
  return keys.length >= requiredKeys.length && keys.length <= allowed.size && keys.every(key => typeof key === "string" && allowed.has(key)
    && Boolean(Object.getOwnPropertyDescriptor(row, key)?.enumerable && Object.getOwnPropertyDescriptor(row, key) && "value" in Object.getOwnPropertyDescriptor(row, key)!))
    && requiredKeys.every(key => Object.hasOwn(row, key))
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined } catch { return undefined }
}
function dense(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > max) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)
    && Number(key) < value.length && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && "value" in Object.getOwnPropertyDescriptor(value, key)!))
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean)
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}
function compare(left: unknown, right: unknown): number { return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8")) }
function canonicalId(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && value.trim() === value && JOB_ID.test(value) }
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function validAttempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function validStatus(value: unknown): value is string { return typeof value === "string" && ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"].includes(value) }
function isSha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value) }
function isMaterialDigest(value: unknown): value is string { return typeof value === "string" && MATERIAL_DIGEST.test(value) }
