import { Buffer } from "node:buffer"
import { canonicalJson } from "@jobcopilot/shared"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { ContextSeedBlock } from "../context/step-context-builder.js"
import { redactJobReadOutput } from "../tools/job-read-output-redaction.js"
import { createDurableDiscoveryAssembly, parseDurableDiscoveryReference, reduceDurableDiscoveryChunk, type DurableDiscoveryReference } from "./child-durable-discovery.js"

const MAX_MODEL_HISTORY_BYTES = 256 * 1024
const MAX_SUMMARY_BYTES = 32 * 1024
const OMITTED_FIELDS = ["company", "description", "evidence", "fullDescription", "location", "logo", "salary", "title", "url", "usage"] as const

type HistoryPair = Readonly<{ toolName: string; status: string; input: unknown; output: unknown }>
type Candidate = Readonly<{ jobId: string; source: string }>
type DiscoveryGroup = { readonly reference: DurableDiscoveryReference; readonly positions: number[]; candidates?: readonly Candidate[]; completionPosition?: number }
type DiscoveryHistory = Readonly<{ verifiedReadPositions: ReadonlySet<number>; groups: readonly DiscoveryGroup[] }>

/** Applies only to the model-facing observation window; durable receipts remain untouched. */
export function projectChildDiscoveryHistory(observations: readonly ContextSeedBlock[]): readonly ContextSeedBlock[] {
  const originalBytes = byteLength(observations)
  if (originalBytes === undefined || originalBytes <= MAX_MODEL_HISTORY_BYTES) return observations
  let history: DiscoveryHistory
  try { history = analyzeDiscoveryHistory(observations.map(pairOfObservation)) } catch { return observations }
  if (history.groups.length === 0) return observations
  const replacements = new Map<number, ContextSeedBlock>(), removed = new Set<number>()
  for (const group of history.groups) {
    if (!group.candidates || group.completionPosition === undefined || group.positions.length === 0) continue
    const block = summaryBlock(group.reference, group.candidates)
    const summaryBytes = byteLength(block)
    if (summaryBytes === undefined || summaryBytes > MAX_SUMMARY_BYTES) continue
    replacements.set(group.completionPosition, block)
    group.positions.forEach(position => removed.add(position))
  }
  if (replacements.size === 0) return observations
  const projected = observations.flatMap((observation, index) => {
    const replacement = replacements.get(index)
    return [...(replacement ? [replacement] : []), ...(removed.has(index) ? [] : [observation])]
  })
  const projectedBytes = byteLength(projected)
  return projectedBytes !== undefined && projectedBytes < originalBytes ? projected : observations
}

/** Keeps the same digest-verified read set used by restored tool observations. */
export function verifiedChildDiscoveryReadPositions(pairs: readonly HistoryPair[]): ReadonlySet<number> {
  return analyzeDiscoveryHistory(pairs).verifiedReadPositions
}

function analyzeDiscoveryHistory(pairs: readonly HistoryPair[]): DiscoveryHistory {
  const assemblies = new Map<string, { readonly group: DiscoveryGroup; readonly assembly: ReturnType<typeof createDurableDiscoveryAssembly> }>()
  const verified = new Set<number>()
  for (const [index, pair] of pairs.entries()) {
    if (pair.toolName === "jobs.discover" && pair.status === "completed") {
      const reference = parseDurableDiscoveryReference(pair.output)
      if (reference && !assemblies.has(reference.ref)) assemblies.set(reference.ref, {
        group: { reference, positions: [] }, assembly: createDurableDiscoveryAssembly(reference),
      })
      else if (reference) {
        const previous = assemblies.get(reference.ref)!.group.reference
        if (previous.byteCount !== reference.byteCount || previous.sha256 !== reference.sha256) throw new Error("child_resume_evidence_invalid")
      }
      continue
    }
    if (pair.toolName !== "tool_results.read" || pair.status !== "completed") continue
    const input = record(pair.input), output = record(pair.output)
    const inputRef = input?.referenceId, outputRef = output?.ref
    const ref = typeof inputRef === "string" && assemblies.has(inputRef) ? inputRef
      : typeof outputRef === "string" && assemblies.has(outputRef) ? outputRef : undefined
    const state = ref ? assemblies.get(ref) : undefined
    if (!state) continue
    const reduction = reduceDurableDiscoveryChunk(state.assembly, pair.output, pair.input)
    if (reduction.kind === "invalid") throw new Error("child_resume_evidence_invalid")
    state.group.positions.push(index)
    if (reduction.kind === "complete") {
      const safe = redactJobReadOutput("jobs.discover", reduction.value)
      if (canonicalJson(safe) !== canonicalJson(reduction.value)) throw new Error("child_resume_evidence_invalid")
      state.group.candidates = candidates(safe)
      state.group.completionPosition = index
      state.group.positions.forEach(position => verified.add(position))
    } else if (state.assembly.complete) verified.add(index)
  }
  return { verifiedReadPositions: verified, groups: [...assemblies.values()].map(value => value.group) }
}

function pairOfObservation(observation: ContextSeedBlock): HistoryPair {
  const content = record(observation.content)
  return { toolName: typeof content?.toolName === "string" ? content.toolName : "",
    status: typeof content?.status === "string" ? content.status : "", input: content?.input, output: content?.output }
}

function candidates(value: RepositoryJsonValue): readonly Candidate[] {
  const output = record(value), jobs = output?.jobs
  if (!Array.isArray(jobs)) throw new Error("child_resume_evidence_invalid")
  return jobs.map(job => {
    const item = record(job)
    if (typeof item?.id !== "string" || typeof item.source !== "string") throw new Error("child_resume_evidence_invalid")
    return { jobId: item.id, source: item.source }
  })
}

function summaryBlock(reference: DurableDiscoveryReference, jobs: readonly Candidate[]): ContextSeedBlock {
  return { id: `child-discovery-history:${reference.ref}`, content: {
    schemaVersion: "agent-harness.v2.child-discovery-history",
    discoveryReference: { $ref: reference.ref, sizeBytes: reference.byteCount, sha256: reference.sha256 },
    candidates: jobs,
    omitted: { reason: "bounded_context", fields: OMITTED_FIELDS },
  } }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function byteLength(value: unknown): number | undefined {
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? undefined : Buffer.byteLength(encoded, "utf8")
  } catch { return undefined }
}
