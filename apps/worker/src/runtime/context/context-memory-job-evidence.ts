import { createHash } from "node:crypto"

import { redactSensitiveText } from "@jobcopilot/shared"
import type { StepContextSnapshot } from "./step-context-builder.js"
import {
  formatCognitiveMemoryJobEvidenceExcerpt,
  validateCognitiveMemoryJobEvidenceExcerpt,
  validateContextMemoryProjection,
  type CognitiveMemoryDecision,
  type CognitiveMemoryJobEvidenceExcerpt,
  type CognitiveMemoryOmittedRange,
  type CognitiveMemoryQuestion,
  type CognitiveMemoryReference,
  type CognitiveMemoryPublicJobFields,
  type ContextMemoryProjection,
} from "./context-memory-schema.js"

const MAX_ITEMS = 32
const MAX_JOB_EVIDENCE_ITEMS = 8
const PUBLIC_JOB_TOOLS = ["jobs.search", "jobs.get"] as const
type Row = Record<string, unknown>
type Observation = StepContextSnapshot["toolObservations"][number]

function plain(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exactJob(value: unknown): Row | null {
  const allowed = ["id", "company", "role", "location", "status", "score", "url", "source", "salary", "description", "keywords"]
  if (!plain(value) || Object.keys(value).length !== allowed.length || allowed.some(key => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) return null
  if (typeof value.id !== "string" || value.id.trim() !== value.id || value.id.length === 0) return null
  if (typeof value.company !== "string" || value.company.trim() !== value.company || value.company.length === 0) return null
  if (typeof value.role !== "string" || value.role.trim() !== value.role || value.role.length === 0) return null
  if (typeof value.status !== "string" || value.status.trim() !== value.status || value.status.length === 0) return null
  for (const field of ["location", "url", "source", "salary", "description", "keywords"] as const) {
    if (value[field] !== null && typeof value[field] !== "string") return null
  }
  return value.score === null || typeof value.score === "number" && Number.isSafeInteger(value.score) ? value : null
}

function publicJobs(content: Row): readonly Row[] | null | undefined {
  if (!PUBLIC_JOB_TOOLS.includes(content.toolName as typeof PUBLIC_JOB_TOOLS[number])) return undefined
  if (content.status !== "completed") return []
  if (content.errorCode !== null || !plain(content.output)) return null
  const output = content.output
  if (content.toolName === "jobs.search") {
    if (Object.keys(output).length !== 3 || !Object.keys(output).every(key => ["jobs", "page", "hasMore"].includes(key)) || !Array.isArray(output.jobs) || output.jobs.length > 50 || !Number.isSafeInteger(output.page as number) || (output.page as number) < 1 || typeof output.hasMore !== "boolean") return null
    const jobs: Row[] = []
    for (const job of output.jobs) {
      const parsed = exactJob(job)
      if (!parsed) return null
      jobs.push(parsed)
    }
    return jobs
  }
  if (Object.keys(output).length !== 1 || output.job === null) return output.job === null ? [] : null
  const job = exactJob(output.job)
  return job ? [job] : null
}

function publicFields(job: Row): CognitiveMemoryPublicJobFields {
  const fields: CognitiveMemoryPublicJobFields = { company: redactSensitiveText(job.company as string), role: redactSensitiveText(job.role as string) }
  for (const field of ["location", "url", "source", "salary", "description"] as const) {
    if (typeof job[field] === "string" && job[field]) Object.assign(fields, { [field]: redactSensitiveText(job[field]) })
  }
  return fields
}

export function publicJobFieldsFromToolOutput(toolName: CognitiveMemoryJobEvidenceExcerpt["toolName"], output: unknown, referenceId: string): CognitiveMemoryPublicJobFields | null {
  if (!plain(output)) return null
  if (toolName === "jobs.search") {
    if (!Array.isArray(output.jobs)) return null
    const job = output.jobs.find(item => plain(item) && item.id === referenceId)
    const parsed = exactJob(job)
    return parsed ? publicFields(parsed) : null
  }
  if (Object.keys(output).length !== 1 || output.job === null) return null
  const parsed = exactJob(output.job)
  return parsed?.id === referenceId ? publicFields(parsed) : null
}

function jobEvidenceId(referenceId: string, sourceRef: string): string {
  return `job-evidence:${createHash("sha256").update(`${referenceId}\0${sourceRef}`, "utf8").digest("hex")}`
}

function isNewerJobEvidence(previous: CognitiveMemoryJobEvidenceExcerpt, current: CognitiveMemoryJobEvidenceExcerpt): boolean {
  if (current.sequence !== undefined) {
    if (previous.sequence === undefined) return true
    const currentSequence = BigInt(current.sequence)
    const previousSequence = BigInt(previous.sequence)
    if (currentSequence !== previousSequence) return currentSequence > previousSequence
  } else if (previous.sequence !== undefined) {
    return false
  }
  return current.sourceRef.localeCompare(previous.sourceRef) > 0
}

export function addJobEvidence(map: Map<string, CognitiveMemoryJobEvidenceExcerpt>, value: CognitiveMemoryJobEvidenceExcerpt): void {
  const previous = map.get(value.referenceId)
  if (!previous || isNewerJobEvidence(previous, value)) map.set(value.referenceId, value)
}

export function extractJobEvidence(observation: Observation, content: Row, refs: ReadonlySet<string>, current: CognitiveMemoryReference): CognitiveMemoryJobEvidenceExcerpt[] | null | undefined {
  if (PUBLIC_JOB_TOOLS.includes(content.toolName as typeof PUBLIC_JOB_TOOLS[number]) && (typeof content.toolCallId !== "string" || observation.id !== `tool-result:${content.toolCallId}`)) return []
  const jobs = publicJobs(content)
  if (jobs === undefined) return undefined
  if (jobs === null || jobs.length === 0) return jobs === null ? null : []
  const result: CognitiveMemoryJobEvidenceExcerpt[] = []
  for (const job of jobs) {
    if (typeof job.id !== "string" || !refs.has(job.id)) continue
    const fields = publicFields(job)
    const candidate: CognitiveMemoryJobEvidenceExcerpt = {
      id: jobEvidenceId(job.id, observation.id),
      referenceId: job.id,
      sourceRef: observation.id,
      toolName: content.toolName as CognitiveMemoryJobEvidenceExcerpt["toolName"],
      trust: "external_untrusted",
      fields,
      excerpt: formatCognitiveMemoryJobEvidenceExcerpt(fields),
      ...(current.goalRevision === undefined ? {} : { goalRevision: current.goalRevision }),
      ...(current.planRevision === undefined ? {} : { planRevision: current.planRevision }),
      ...(current.sequence === undefined ? {} : { sequence: current.sequence }),
    }
    const validated = validateCognitiveMemoryJobEvidenceExcerpt(candidate)
    if (validated) result.push(validated)
  }
  return result
}

export function referenceScope(value: CognitiveMemoryReference, expectedGoalRevision: number | undefined, expectedPlanRevision: number | undefined): "current" | "stale" | "future" {
  if (expectedGoalRevision === undefined || value.goalRevision === undefined || value.goalRevision === expectedGoalRevision && (expectedPlanRevision === undefined || value.planRevision === undefined || value.planRevision === expectedPlanRevision)) return "current"
  if (value.goalRevision !== undefined && value.goalRevision > expectedGoalRevision) return "future"
  if (expectedPlanRevision !== undefined && value.goalRevision === expectedGoalRevision && value.planRevision !== undefined && value.planRevision > expectedPlanRevision) return "future"
  return "stale"
}

function excerptScope(value: CognitiveMemoryJobEvidenceExcerpt, expectedGoalRevision: number | undefined, expectedPlanRevision: number | undefined): "current" | "stale" | "future" {
  return referenceScope(value, expectedGoalRevision, expectedPlanRevision)
}

function add<T extends { readonly id: string }>(map: Map<string, T>, value: T | null): boolean {
  if (!value) return false
  const previous = map.get(value.id)
  if (previous && JSON.stringify(previous) !== JSON.stringify(value)) return false
  map.set(value.id, value)
  return true
}

export function mergePriorMemory(content: Row, maps: readonly Map<string, CognitiveMemoryReference>[], jobEvidence: Map<string, CognitiveMemoryJobEvidenceExcerpt>, decisions: Map<string, CognitiveMemoryDecision>, questions: Map<string, CognitiveMemoryQuestion>, plans: { goalRevision: number; planRevision: number }[], ranges: CognitiveMemoryOmittedRange[], expectedGoalRevision: number | undefined, expectedPlanRevision: number | undefined): bigint | null | false {
  const normalized = validateContextMemoryProjection(content.memory, expectedGoalRevision === undefined ? {} : { expectedGoalRevision, ...(expectedPlanRevision === undefined ? {} : { expectedPlanRevision }) })
  if (!normalized) return false
  const fields = ["unresolved", "waits", "approvals", "verifiedEvidence", "artifacts", "taskRefs", "eventRefs"]
  for (const [index, field] of fields.entries()) {
    for (const value of normalized[field as keyof ContextMemoryProjection] as readonly CognitiveMemoryReference[]) {
      const scope = referenceScope(value, expectedGoalRevision, expectedPlanRevision)
      if (scope === "future" || scope === "current" && !add(maps[index]!, value)) return false
    }
  }
  for (const value of normalized.jobEvidenceExcerpts) {
    const scope = excerptScope(value, expectedGoalRevision, expectedPlanRevision)
    if (scope === "future") return false
    if (scope === "current") addJobEvidence(jobEvidence, value)
  }
  for (const value of normalized.decisions) if (!add(decisions, value)) return false
  for (const value of normalized.unresolvedQuestions) if (!add(questions, value)) return false
  const { goalRevision, planRevision } = normalized.revisions
  if (goalRevision !== null && planRevision !== null && (expectedPlanRevision === undefined || goalRevision !== expectedGoalRevision || planRevision <= expectedPlanRevision)) plans.push({ goalRevision, planRevision })
  ranges.push(...normalized.omittedRanges)
  if (maps.some(map => map.size > MAX_ITEMS) || jobEvidence.size > MAX_JOB_EVIDENCE_ITEMS || decisions.size > MAX_ITEMS || questions.size > MAX_ITEMS || ranges.length > MAX_ITEMS) return false
  if (normalized.coveredSequence === null) return null
  return BigInt(normalized.coveredSequence)
}
