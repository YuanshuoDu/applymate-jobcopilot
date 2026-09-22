import { Buffer } from "node:buffer"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { StepContextSnapshot } from "./step-context-builder.js"
import { deriveContextMemoryNarrative, validateContextMemoryProjection, type CognitiveMemoryAnchor, type CognitiveMemoryDecision, type CognitiveMemoryJobEvidenceExcerpt, type CognitiveMemoryOmittedRange, type CognitiveMemoryQuestion, type CognitiveMemoryReference, type ContextMemoryProjection } from "./context-memory-schema.js"
import { addJobEvidence, extractJobEvidence, mergePriorMemory, referenceScope } from "./context-memory-job-evidence.js"
import { resolveLatestAcceptedPlanCallId } from "../planning/plan-revision-scope.js"
const MAX_BYTES = 8 * 1024
const MAX_ENTRIES = 256
const MAX_ITEMS = 32
const MAX_ID = 256
const MAX_SUMMARY = 160
const SNAPSHOT_KEYS = new Set(["system", "profile", "goal", "steerHistory", "businessRefs", "toolObservations"])
const FAILURE_STATUSES = new Set(["failed", "interrupted", "cancelled"])
const WAIT_TOOL_NAMES = ["agent.wait", "wait_subagents"] as const
type WaitToolName = typeof WAIT_TOOL_NAMES[number]

export type { CognitiveMemoryAnchor, CognitiveMemoryDecision, CognitiveMemoryOmittedRange, CognitiveMemoryQuestion, CognitiveMemoryReference, ContextMemoryProjection } from "./context-memory-schema.js"
export type ContextMemoryProjectionOptions = { readonly maxBytes?: number }
type Row = Record<string, unknown>
type Observation = StepContextSnapshot["toolObservations"][number]
type BusinessRef = { readonly id: string; readonly kind: string; readonly ownerId: string; readonly resource?: string; readonly hash?: string }
function isWaitToolName(value: unknown): value is WaitToolName {
  return typeof value === "string" && WAIT_TOOL_NAMES.includes(value as WaitToolName)
}

function plain(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= MAX_ID
}
function sequence(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") return null
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null
  if (typeof value === "string" && !/^(0|[1-9]\d*)$/.test(value)) return null
  try {
    const result = typeof value === "bigint" ? value : BigInt(value as string | number)
    if (result < 0n) return null
    return result.toString()
  } catch { return null }
}
function safeSummary(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  const compact = redactSensitiveText(value.replace(/\s+/g, " ").trim())
    .replace(/\b(?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .slice(0, MAX_SUMMARY)
  return compact.length > 0 ? compact : undefined
}
function snapshotShape(snapshot: StepContextSnapshot): boolean {
  if (!snapshot || typeof snapshot !== "object" || Object.keys(snapshot).some(key => !SNAPSHOT_KEYS.has(key))) return false
  const value = snapshot as unknown as Row
  if (!["system", "profile", "steerHistory", "businessRefs", "toolObservations"].every(key => Array.isArray(value[key]))) return false
  if (value.goal !== undefined && !plain(value.goal)) return false
  return [value.system, value.profile, value.steerHistory, value.businessRefs, value.toolObservations].every(items => (items as unknown[]).length <= MAX_ENTRIES)
}
function businessRefs(value: unknown): readonly BusinessRef[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>(), result: BusinessRef[] = []
  for (const item of value) {
    if (!plain(item) || Object.keys(item).some(key => !["id", "kind", "ownerId", "label", "hash", "summary", "resource"].includes(key)) || !validId(item.id) || typeof item.kind !== "string" || item.kind.length === 0 || typeof item.ownerId !== "string" || item.ownerId.length === 0 || seen.has(item.id)) return null
    if (item.resource !== undefined && typeof item.resource !== "string") return null
    if (item.hash !== undefined && (typeof item.hash !== "string" || item.hash.length > 256)) return null
    seen.add(item.id)
    result.push({ id: item.id, kind: item.kind, ownerId: item.ownerId, ...(item.resource === undefined ? {} : { resource: item.resource }), ...(item.hash === undefined ? {} : { hash: item.hash }) })
  }
  return result
}
function blocks(value: unknown): readonly { readonly id: string; readonly content: unknown }[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const result: { readonly id: string; readonly content: unknown }[] = []
  for (const item of value) {
    if (!plain(item) || Object.keys(item).some(key => key !== "id" && key !== "content") || !validId(item.id) || seen.has(item.id)) return null
    seen.add(item.id)
    result.push({ id: item.id, content: item.content })
  }
  return result
}
function sorted<T extends { readonly id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id))
}
function anchor(block: { readonly id: string; readonly content: unknown }, trust: CognitiveMemoryAnchor["trust"]): CognitiveMemoryAnchor {
  const content = plain(block.content) ? block.content : null
  const summary = safeSummary(typeof block.content === "string" ? block.content : content?.summary ?? content?.objective)
  return summary === undefined ? { id: block.id, trust } : { id: block.id, trust, summary }
}
function constraintAnchors(goal: { readonly id: string; readonly content: unknown } | undefined): CognitiveMemoryAnchor[] | null {
  if (!goal || !plain(goal.content) || goal.content.constraints === undefined) return []
  if (!Array.isArray(goal.content.constraints) || goal.content.constraints.length > MAX_ITEMS) return null
  const result: CognitiveMemoryAnchor[] = []
  for (const [index, value] of goal.content.constraints.entries()) {
    const summary = safeSummary(value)
    if (summary === undefined) return null
    result.push({ id: `${goal.id}:constraint:${index}`, trust: "external_untrusted", summary })
  }
  return sorted(result)
}
function reference(observation: Observation, content: Row): CognitiveMemoryReference | null {
  const result: { id: string; status?: string; goalRevision?: number; planRevision?: number; sequence?: string } = { id: observation.id }
  if (content.status !== undefined) {
    if (typeof content.status !== "string" || content.status.trim() !== content.status || content.status.length === 0 || content.status.length > 64) return null
    result.status = content.status
  }
  const goalRevision = content.goalRevision
  const planRevision = content.planRevision
  if (goalRevision !== undefined && (!Number.isSafeInteger(goalRevision) || (goalRevision as number) < 1)) return null
  if (planRevision !== undefined && (!Number.isSafeInteger(planRevision) || (planRevision as number) < 1)) return null
  if (goalRevision !== undefined) result.goalRevision = goalRevision as number
  if (planRevision !== undefined) result.planRevision = planRevision as number
  const currentSequence = sequence(content.sequence)
  if (currentSequence === null) return null
  if (currentSequence !== undefined) result.sequence = currentSequence
  return result
}
function add<T extends { readonly id: string }>(map: Map<string, T>, value: T | null): boolean {
  if (!value) return false
  const previous = map.get(value.id)
  if (previous && JSON.stringify(previous) !== JSON.stringify(value)) return false
  map.set(value.id, value)
  return true
}
function isCriticalId(id: string): boolean {
  return ["plan-revision:", "plan-result:", "plan-control:", "wait-result:", "approval:", "artifact:", "task:", "event:"].some(prefix => id.startsWith(prefix))
}

function criticalObservationValid(id: string, content: Row): boolean {
  if (id.startsWith("plan-result:")) return content.kind === "plan_command" && validId(content.localId) && typeof content.status === "string"
  if (id.startsWith("plan-control:")) return content.kind === "plan_control" && validId(content.localId) && typeof content.status === "string"
  if (id.startsWith("wait-result:") || id.startsWith("approval:")) return typeof content.status === "string" && content.status.trim() === content.status
  return true
}

export function isContextMemoryAnchorObservation(observation: Observation): boolean {
  if (!validId(observation.id)) return false
  if (isCriticalId(observation.id)) return true
  const content = plain(observation.content) ? observation.content : null
  return content?.kind === "context_snapshot_memory" || content?.kind === "plan_revision" || content?.kind === "plan_command" || content?.kind === "plan_control" || content?.kind === "plan_replan_feedback" || isWaitToolName(content?.toolName) || content?.approvalId !== undefined
}

function trimProjection(value: ContextMemoryProjection, maxBytes: number): ContextMemoryProjection | null {
  const encoded = (candidate: ContextMemoryProjection): string => JSON.stringify(candidate)
  if (Buffer.byteLength(encoded(value), "utf8") <= maxBytes) return value
  const fields: (keyof ContextMemoryProjection)[] = ["jobEvidenceExcerpts", "eventRefs", "taskRefs", "artifacts", "verifiedEvidence", "unresolved"]
  let candidate = value
  for (const field of fields) {
    if (!Array.isArray(candidate[field])) continue
    let entries = candidate[field] as readonly unknown[]
    while (entries.length > 0 && Buffer.byteLength(encoded(candidate), "utf8") > maxBytes) {
      candidate = { ...candidate, [field]: entries.slice(0, -1) } as ContextMemoryProjection
      entries = candidate[field] as readonly unknown[]
    }
  }
  if (Buffer.byteLength(encoded(candidate), "utf8") <= maxBytes) return candidate
  const strip = (field: "activeGoals" | "fixedConstraints" | "steering"): ContextMemoryProjection => ({ ...candidate, [field]: candidate[field].map(item => ({ id: item.id, trust: item.trust })) })
  candidate = strip("steering")
  candidate = strip("fixedConstraints")
  candidate = strip("activeGoals")
  return Buffer.byteLength(encoded(candidate), "utf8") <= maxBytes ? candidate : null
}
export function buildContextMemoryProjection(snapshot: StepContextSnapshot, options: ContextMemoryProjectionOptions = {}): ContextMemoryProjection | null {
  const maxBytes = options.maxBytes ?? MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_BYTES || !snapshotShape(snapshot)) return null
  const system = blocks(snapshot.system), profile = blocks(snapshot.profile), steering = blocks(snapshot.steerHistory), observations = blocks(snapshot.toolObservations), business = businessRefs(snapshot.businessRefs)
  if (!system || !profile || !steering || !observations || !business) return null
  const goal = snapshot.goal === undefined ? undefined : blocks([snapshot.goal])?.[0]
  if (snapshot.goal !== undefined && !goal) return null
  const activeGoals = goal ? [anchor(goal, "external_untrusted")] : []
  const goalConstraints = constraintAnchors(goal)
  if (!goalConstraints) return null
  const fixedConstraints = sorted([...system.map(item => anchor(item, "system")), ...goalConstraints])
  const userSteering = sorted(steering.map(item => anchor(item, "external_untrusted")))
  const goalContent = goal && plain(goal.content) ? goal.content : null
  if (goalContent?.revision !== undefined && (!Number.isSafeInteger(goalContent.revision) || (goalContent.revision as number) < 1)) return null
  const expectedGoalRevision = goalContent?.revision as number | undefined
  const planScope = expectedGoalRevision === undefined ? { kind: "unknown" as const } : resolveLatestAcceptedPlanCallId(observations.map(item => ({ id: item.id, content: item.content })), expectedGoalRevision)
  const expectedPlanRevision = planScope.kind === "known" ? planScope.planRevision : undefined
  const unresolved = new Map<string, CognitiveMemoryReference>(), waits = new Map<string, CognitiveMemoryReference>(), approvals = new Map<string, CognitiveMemoryReference>(), verified = new Map<string, CognitiveMemoryReference>(), artifacts = new Map<string, CognitiveMemoryReference>(), tasks = new Map<string, CognitiveMemoryReference>(), events = new Map<string, CognitiveMemoryReference>()
  const decisions = new Map<string, CognitiveMemoryDecision>(), questions = new Map<string, CognitiveMemoryQuestion>(), jobEvidence = new Map<string, CognitiveMemoryJobEvidenceExcerpt>()
  const publicJobRefs = new Set(business.filter(item => (item.kind === "job" || item.kind === "jd") && (item.resource === undefined || item.resource === "job")).map(item => item.id))
  const planRows: { goalRevision: number; planRevision: number }[] = []
  let covered: bigint | null = null
  const omittedRanges: CognitiveMemoryOmittedRange[] = []
  for (const item of business) {
    const ref: CognitiveMemoryReference = { id: item.id }
    if (item.kind === "artifact" || item.kind === "attachment") if (!add(artifacts, ref)) return null
    if (item.resource === "persona_fact" || item.resource === "persona_evidence_chunk") if (!add(verified, ref)) return null
  }
  for (const item of observations) {
    const content = plain(item.content) ? item.content : {}
    if (isCriticalId(item.id) && !criticalObservationValid(item.id, content)) return null
    const current = reference(item as Observation, content)
    if (!current) return null
    const scope = referenceScope(current, expectedGoalRevision, expectedPlanRevision)
    if (scope === "future") return null
    if (current.sequence !== undefined) { const value = BigInt(current.sequence); if (covered === null || value > covered) covered = value }
    const kind = typeof content.kind === "string" ? content.kind : ""
    if (item.id.startsWith("plan-revision:") || kind === "plan_revision") {
      if (kind !== "plan_revision" || !Number.isSafeInteger(content.goalRevision) || !Number.isSafeInteger(content.planRevision) || (content.goalRevision as number) < 1 || (content.planRevision as number) < 1) return null
      planRows.push({ goalRevision: content.goalRevision as number, planRevision: content.planRevision as number })
    }
    if (scope === "current") {
      if (item.id.startsWith("wait-result:") || kind === "wait_result" || isWaitToolName(content.toolName)) if (!add(waits, current)) return null
      if (item.id.startsWith("approval:") || typeof content.approvalId === "string" || kind === "approval") if (!add(approvals, current)) return null
      if (item.id.startsWith("artifact:") || typeof content.artifactId === "string") if (!add(artifacts, current)) return null
      if (item.id.startsWith("task:") || typeof content.taskId === "string") if (!add(tasks, current)) return null
      if (item.id.startsWith("event:") || typeof content.eventId === "string" || isCriticalId(item.id)) if (!add(events, current)) return null
      if (content.verified === true || typeof content.evidenceRef === "string" || item.id.startsWith("evidence:") || item.id.startsWith("read:")) if (!add(verified, current)) return null
      if (["waiting", "pending", "running", "retrying", ...FAILURE_STATUSES].includes(current.status ?? "") || kind === "plan_control") if (!add(unresolved, current)) return null
    }
    if (kind === "context_summary" && plain(content.value) && Array.isArray(content.value.removedObservationIds) && content.value.removedObservationIds.every(validId)) {
      const ids = content.value.removedObservationIds as string[]
      if (ids.length > 0) omittedRanges.push({ fromId: ids[0]!, toId: ids[ids.length - 1]!, reason: "compaction" })
    }
    if (kind === "context_summary" && content.memory !== undefined) {
      const prior = mergePriorMemory(content, [unresolved, waits, approvals, verified, artifacts, tasks, events], jobEvidence, decisions, questions, planRows, omittedRanges, expectedGoalRevision, expectedPlanRevision)
      if (prior === false) return null
      if (prior !== null && (covered === null || prior > covered)) covered = prior
    }
    if (scope === "current") {
      const evidence = extractJobEvidence(item as Observation, content, publicJobRefs, current)
      if (evidence === null) continue
      for (const value of evidence ?? []) addJobEvidence(jobEvidence, value)
    }
  }
  const revisions = planRows.sort((left, right) => left.goalRevision - right.goalRevision || left.planRevision - right.planRevision)
  const goalRevision = goalContent?.revision as number | undefined ?? revisions.at(-1)?.goalRevision ?? null
  const latest = revisions.filter(item => item.goalRevision === goalRevision).at(-1)
  for (const [id, item] of decisions) if (item.goalRevision !== goalRevision) decisions.delete(id)
  for (const [id, item] of questions) if (item.goalRevision !== goalRevision) questions.delete(id)
  const narrative = deriveContextMemoryNarrative(snapshot.toolObservations, goalRevision, expectedPlanRevision)
  for (const item of narrative.decisions) if (!add(decisions, item)) return null
  for (const item of narrative.unresolvedQuestions) if (!add(questions, item)) return null
  const projection: ContextMemoryProjection = { schemaVersion: "agent-harness.cognitive-memory.v1", activeGoals: activeGoals.slice(0, MAX_ITEMS), fixedConstraints: fixedConstraints.slice(0, MAX_ITEMS), steering: userSteering.slice(0, MAX_ITEMS), revisions: { goalRevision, planRevision: latest?.planRevision ?? null }, decisions: sorted([...decisions.values()]).slice(0, MAX_ITEMS), unresolvedQuestions: sorted([...questions.values()]).slice(0, MAX_ITEMS), jobEvidenceExcerpts: sorted([...jobEvidence.values()]).slice(0, 8), unresolved: sorted([...unresolved.values()]).slice(0, MAX_ITEMS), waits: sorted([...waits.values()]).slice(0, MAX_ITEMS), approvals: sorted([...approvals.values()]).slice(0, MAX_ITEMS), verifiedEvidence: sorted([...verified.values()]).slice(0, MAX_ITEMS), artifacts: sorted([...artifacts.values()]).slice(0, MAX_ITEMS), taskRefs: sorted([...tasks.values()]).slice(0, MAX_ITEMS), eventRefs: sorted([...events.values()]).slice(0, MAX_ITEMS), omittedRanges: omittedRanges.sort((left, right) => left.fromId.localeCompare(right.fromId)).slice(0, MAX_ITEMS), coveredSequence: covered?.toString() ?? null }
  const trimmed = trimProjection(projection, maxBytes)
  return trimmed ? validateContextMemoryProjection(trimmed, { maxBytes, ...(goalRevision === null ? {} : { expectedGoalRevision: goalRevision }), ...(expectedPlanRevision === undefined ? {} : { expectedPlanRevision }) }) : null
}
