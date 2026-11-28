import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type { TaskGraphVerificationContract, TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { isCanonicalJobId, redactJobReadOutput } from "../tools/job-read-output-redaction.js"
import {
  createDurableDiscoveryAssembly,
  parseDurableDiscoveryReference,
  reduceDurableDiscoveryChunk,
  type DurableDiscoveryAssembly,
} from "./child-durable-discovery.js"
import type { TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"

const MAX_DESCRIPTION_BYTES = 100_000
const MAX_DISCOVER_JOBS = 50
const MAX_BUFFERED_DISCOVERY_BYTES = 1024 * 1024

/** Private receipt-derived description fingerprints; never serialized into a report or model projection. */
export type TaskGraphJobDescriptionWitnesses = ReadonlyMap<string, readonly string[]>

type Row = Record<string, unknown>
type ToolObservation = Readonly<{ name: string; input: unknown; output: unknown; completed: boolean }>

function plainRecord(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => typeof key === "string")
      ? value as Row : undefined
  } catch { return undefined }
}

function safeDescriptionDigest(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > MAX_DESCRIPTION_BYTES) return undefined
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function addJobDescription(target: Map<string, Set<string>>, job: unknown, relevantJobIds: ReadonlySet<string>): void {
  const row = plainRecord(job)
  if (!row || !isCanonicalJobId(row.id) || !relevantJobIds.has(row.id)) return
  const digest = safeDescriptionDigest(row.description)
  if (!digest) return
  const values = target.get(row.id) ?? new Set<string>()
  if (values.size < 2) values.add(digest)
  target.set(row.id, values)
}

function safeOutputMatches(toolName: "jobs.get" | "jobs.discover", value: unknown): unknown | undefined {
  try {
    const safe = redactJobReadOutput(toolName, value)
    return safe === "[REDACTED]" || canonicalTaskGraphJson(safe) !== canonicalTaskGraphJson(value) ? undefined : safe
  } catch { return undefined }
}

function observationsFromReceipts(receipts: TaskGraphVerificationReceipts): ToolObservation[] {
  const calls = new Map<string, Row>(), results = new Map<string, Row>()
  for (const item of receipts.items) {
    const content = plainRecord(item.content), callId = content?.toolCallId
    if (!content || typeof callId !== "string") continue
    if (item.type === "tool_call") calls.set(callId, content)
    else if (item.type === "tool_result") results.set(callId, content)
  }
  const observations: ToolObservation[] = []
  for (const [callId, call] of calls) {
    const result = results.get(callId), toolName = call.toolName
    if (!result || typeof toolName !== "string") continue
    observations.push({ name: toolName, input: call.input, output: result.output, completed: receipts.outcomes.get(callId) === "completed" })
  }
  return observations
}

function recordInlineDiscoveries(value: unknown, target: Map<string, Set<string>>, relevantJobIds: ReadonlySet<string>): boolean {
  const safe = safeOutputMatches("jobs.discover", value), output = plainRecord(safe)
  if (!output || !Array.isArray(output.jobs) || output.jobs.length > MAX_DISCOVER_JOBS) return false
  for (const job of output.jobs) addJobDescription(target, job, relevantJobIds)
  return true
}

/** Extracts fingerprints only from validated redacted receipts and digest-checked discovery chunks. */
export function taskGraphJobDescriptionWitnesses(
  receipts: TaskGraphVerificationReceipts,
  relevantJobIds: readonly string[],
  role: "scout" | "analyst",
): TaskGraphJobDescriptionWitnesses {
  const relevant = new Set(relevantJobIds.filter(isCanonicalJobId))
  if (relevant.size === 0) return new Map()
  const descriptions = new Map<string, Set<string>>()
  const assemblies = new Map<string, DurableDiscoveryAssembly>()
  const completedReferences = new Set<string>()
  let bufferedBytes = 0

  for (const observation of observationsFromReceipts(receipts)) {
    if (!observation.completed) continue
    if (role === "analyst" && observation.name === "jobs.get") {
      const safe = safeOutputMatches("jobs.get", observation.output), output = plainRecord(safe), job = plainRecord(output?.job)
      const input = plainRecord(observation.input)
      if (job && input?.jobId === job.id) addJobDescription(descriptions, job, relevant)
      continue
    }
    if (role === "scout" && observation.name === "jobs.discover") {
      let reference
      try { reference = parseDurableDiscoveryReference(observation.output) }
      catch { throw new Error("task_graph_job_description_receipt_invalid") }
      if (reference) {
        const previous = assemblies.get(reference.ref)
        if (previous && (previous.reference.sha256 !== reference.sha256 || previous.reference.byteCount !== reference.byteCount)) {
          throw new Error("task_graph_job_description_receipt_ambiguous")
        }
        if (!previous) assemblies.set(reference.ref, createDurableDiscoveryAssembly(reference))
      } else recordInlineDiscoveries(observation.output, descriptions, relevant)
      continue
    }
    if (role !== "scout" || observation.name !== "tool_results.read") continue
    const input = plainRecord(observation.input), output = plainRecord(observation.output)
    const referenceId = input?.referenceId
    const assembly = typeof referenceId === "string" ? assemblies.get(referenceId) : undefined
    if (!assembly || !output || completedReferences.has(assembly.reference.ref)) continue
    const reduction = reduceDurableDiscoveryChunk(assembly, observation.output, observation.input,
      MAX_BUFFERED_DISCOVERY_BYTES - bufferedBytes + assembly.bytesStored)
    bufferedBytes += reduction.addedBytes - reduction.releasedBytes
    if (reduction.kind === "invalid") throw new Error("task_graph_job_description_receipt_invalid")
    if (reduction.kind !== "complete") continue
    completedReferences.add(assembly.reference.ref)
    recordInlineDiscoveries(reduction.value, descriptions, relevant)
  }

  return new Map([...descriptions].map(([jobId, digests]) => [jobId, [...digests].sort()]))
}

export function taskGraphJobDescriptionDependencyNodeKeys(contract: TaskGraphVerificationContract): string[] {
  const keys = contract.criteria.flatMap(({ check }) => check.kind === "findings_from_scout_dependency"
    ? [check.dependencyNodeKey]
    : check.kind === "findings_cover_each_scout_candidates_gte" ? [...check.dependencyNodeKeys] : [])
  return [...new Set(keys)].sort()
}

export function taskGraphHasScoutJobDescriptionWitness(input: Readonly<{
  analyst: Readonly<{ findings: readonly Readonly<{ jobId: string }>[] }>
  dependencies: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
  requiredScoutNodeKeys: readonly string[]
  scoutWitnesses: ReadonlyMap<string, TaskGraphJobDescriptionWitnesses>
}>): boolean {
  const usedJobIds = new Set(input.analyst.findings.map(finding => finding.jobId))
  return [...new Set(input.requiredScoutNodeKeys)].some(nodeKey => {
    const projection = input.dependencies.get(nodeKey), witnesses = input.scoutWitnesses.get(nodeKey)
    return projection?.role === "scout" && projection.candidates.some(candidate => usedJobIds.has(candidate.jobId)
      && Boolean(witnesses?.get(candidate.jobId)?.length))
  })
}

/** Compares only used Analyst findings against their verified typed Scout candidate rows. */
export function taskGraphJobDescriptionConflict(input: Readonly<{
  analyst: Readonly<{ findings: readonly Readonly<{ jobId: string }>[] }>
  dependencies: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
  requiredScoutNodeKeys: readonly string[]
  scoutWitnesses: ReadonlyMap<string, TaskGraphJobDescriptionWitnesses>
  analystWitnesses: TaskGraphJobDescriptionWitnesses
}>): boolean {
  const usedJobIds = new Set(input.analyst.findings.map(finding => finding.jobId))
  const scoutDigests = new Map<string, Set<string>>()
  const scoutNodeKeys = [...new Set(input.requiredScoutNodeKeys)].sort()
  for (const nodeKey of scoutNodeKeys) {
    const projection = input.dependencies.get(nodeKey), witnesses = input.scoutWitnesses.get(nodeKey)
    if (!projection || projection.role !== "scout") continue
    for (const candidate of projection.candidates) {
      if (!usedJobIds.has(candidate.jobId)) continue
      const values = witnesses?.get(candidate.jobId)
      if (!values?.length) continue
      const accumulated = scoutDigests.get(candidate.jobId) ?? new Set<string>()
      for (const digest of values) accumulated.add(digest)
      scoutDigests.set(candidate.jobId, accumulated)
    }
  }
  for (const [jobId, sourceValues] of scoutDigests) {
    const analystValues = input.analystWitnesses.get(jobId)
    if (sourceValues.size > 1 || analystValues && new Set(analystValues).size > 1) return true
    if (sourceValues.size > 0 && analystValues?.some(digest => !sourceValues.has(digest))) return true
  }
  return false
}
