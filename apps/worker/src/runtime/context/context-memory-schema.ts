import { Buffer } from "node:buffer"

export type CognitiveMemoryTrust = "system" | "user_confirmed" | "internal_record" | "external_untrusted"
export type CognitiveMemoryAnchor = { readonly id: string; readonly trust: CognitiveMemoryTrust; readonly summary?: string }
export type CognitiveMemoryReference = { readonly id: string; readonly status?: string; readonly goalRevision?: number; readonly planRevision?: number; readonly sequence?: string }
export type CognitiveMemoryOmittedRange = { readonly fromId: string; readonly toId: string; readonly reason: "compaction" }
export type CognitiveMemoryDecision = { readonly id: string; readonly summary: string; readonly sourceRef: string; readonly goalRevision: number; readonly planRevision: number }
export type CognitiveMemoryQuestion = { readonly id: string; readonly summary: string; readonly sourceRef: string; readonly goalRevision: number; readonly planRevision?: number }
export type ContextMemoryProjection = {
  readonly schemaVersion: "agent-harness.cognitive-memory.v1"
  readonly activeGoals: readonly CognitiveMemoryAnchor[]
  readonly fixedConstraints: readonly CognitiveMemoryAnchor[]
  readonly steering: readonly CognitiveMemoryAnchor[]
  readonly revisions: { readonly goalRevision: number | null; readonly planRevision: number | null }
  readonly decisions: readonly CognitiveMemoryDecision[]
  readonly unresolvedQuestions: readonly CognitiveMemoryQuestion[]
  readonly unresolved: readonly CognitiveMemoryReference[]
  readonly waits: readonly CognitiveMemoryReference[]
  readonly approvals: readonly CognitiveMemoryReference[]
  readonly verifiedEvidence: readonly CognitiveMemoryReference[]
  readonly artifacts: readonly CognitiveMemoryReference[]
  readonly taskRefs: readonly CognitiveMemoryReference[]
  readonly eventRefs: readonly CognitiveMemoryReference[]
  readonly omittedRanges: readonly CognitiveMemoryOmittedRange[]
  readonly coveredSequence: string | null
}

const MAX_BYTES = 8 * 1024
const MAX_ITEMS = 32
const MAX_ID = 256
const MAX_TEXT = 160
const MAX_SEQUENCE_DIGITS = 20
type Row = Record<string, unknown>
type Observation = { readonly id: string; readonly content: unknown }

function plain(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function keys(value: Row, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed)
  return Object.keys(value).every(key => accepted.has(key))
}
function own(value: Row, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field)
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= MAX_ID
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(value) && !/\b(?:password|secret|token|api[_-]?key|authorization)\s*[:=]/i.test(value)
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}
function parseSequence(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || value.length > MAX_SEQUENCE_DIGITS) return null
  return value
}
function ordered<T extends { readonly id: string }>(values: readonly T[]): boolean {
  for (let index = 1; index < values.length; index += 1) if (values[index - 1]!.id.localeCompare(values[index]!.id) >= 0) return false
  return true
}
function anchor(value: unknown): CognitiveMemoryAnchor | null {
  if (!plain(value) || !keys(value, ["id", "trust", "summary"]) || !id(value.id) || !["system", "user_confirmed", "internal_record", "external_untrusted"].includes(value.trust as string)) return null
  if (own(value, "summary") && (value.summary === undefined || !text(value.summary))) return null
  const summary = value.summary === undefined ? undefined : value.summary as string
  return { id: value.id, trust: value.trust as CognitiveMemoryTrust, ...(summary === undefined ? {} : { summary }) }
}
function anchors(value: unknown): CognitiveMemoryAnchor[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const result: CognitiveMemoryAnchor[] = []
  for (const item of value) { const parsed = anchor(item); if (!parsed) return null; result.push(parsed) }
  return ordered(result) ? result : null
}
function reference(value: unknown): CognitiveMemoryReference | null {
  if (!plain(value) || !keys(value, ["id", "status", "goalRevision", "planRevision", "sequence"]) || !id(value.id)) return null
  if (own(value, "status") && (value.status === undefined || typeof value.status !== "string" || value.status.trim() !== value.status || value.status.length === 0 || value.status.length > 64)) return null
  if (own(value, "goalRevision") && (value.goalRevision === undefined || !revision(value.goalRevision))) return null
  if (own(value, "planRevision") && (value.planRevision === undefined || !revision(value.planRevision))) return null
  if (own(value, "sequence") && value.sequence === undefined) return null
  const sequence = parseSequence(value.sequence)
  if (sequence === null) return null
  return { id: value.id, ...(value.status === undefined ? {} : { status: value.status as string }), ...(value.goalRevision === undefined ? {} : { goalRevision: value.goalRevision as number }), ...(value.planRevision === undefined ? {} : { planRevision: value.planRevision as number }), ...(sequence === undefined ? {} : { sequence }) }
}
function references(value: unknown): CognitiveMemoryReference[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const result: CognitiveMemoryReference[] = []
  for (const item of value) { const parsed = reference(item); if (!parsed) return null; result.push(parsed) }
  return ordered(result) ? result : null
}
function narrative(value: unknown, question: boolean): CognitiveMemoryDecision | CognitiveMemoryQuestion | null {
  const allowed = question ? ["id", "summary", "sourceRef", "goalRevision", "planRevision"] : ["id", "summary", "sourceRef", "goalRevision", "planRevision"]
  const sourcePrefixes = question ? ["wait-result:", "approval:"] : ["plan-revision:", "goal-revision:", "approval:", "event:"]
  if (!plain(value) || !keys(value, allowed) || !id(value.id) || !text(value.summary) || !id(value.sourceRef) || !revision(value.goalRevision)) return null
  const sourceRef = value.sourceRef
  if (!sourcePrefixes.some(prefix => sourceRef.startsWith(prefix))) return null
  if (own(value, "planRevision") && value.planRevision === undefined || !revision(value.planRevision) && (!question || value.planRevision !== undefined)) return null
  return question
    ? { id: value.id, summary: value.summary, sourceRef: value.sourceRef, goalRevision: value.goalRevision, ...(value.planRevision === undefined ? {} : { planRevision: value.planRevision }) }
    : { id: value.id, summary: value.summary, sourceRef: value.sourceRef, goalRevision: value.goalRevision, planRevision: value.planRevision as number }
}
function narratives(value: unknown, question: boolean): (CognitiveMemoryDecision | CognitiveMemoryQuestion)[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const result: (CognitiveMemoryDecision | CognitiveMemoryQuestion)[] = []
  for (const item of value) { const parsed = narrative(item, question); if (!parsed) return null; result.push(parsed) }
  return ordered(result) ? result : null
}
function ranges(value: unknown): CognitiveMemoryOmittedRange[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const result: CognitiveMemoryOmittedRange[] = []
  for (const item of value) {
    if (!plain(item) || !keys(item, ["fromId", "toId", "reason"]) || !id(item.fromId) || !id(item.toId) || item.reason !== "compaction") return null
    result.push({ fromId: item.fromId, toId: item.toId, reason: "compaction" })
  }
  return result.every((item, index) => index === 0 || item.fromId.localeCompare(result[index - 1]!.fromId) > 0) ? result : null
}

export type ContextMemoryValidationOptions = { readonly maxBytes?: number; readonly expectedGoalRevision?: number; readonly expectedPlanRevision?: number }
export function validateContextMemoryProjection(value: unknown, options: ContextMemoryValidationOptions = {}): ContextMemoryProjection | null {
  const maxBytes = options.maxBytes ?? MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_BYTES || !plain(value) || !keys(value, ["schemaVersion", "activeGoals", "fixedConstraints", "steering", "revisions", "decisions", "unresolvedQuestions", "unresolved", "waits", "approvals", "verifiedEvidence", "artifacts", "taskRefs", "eventRefs", "omittedRanges", "coveredSequence"]) || value.schemaVersion !== "agent-harness.cognitive-memory.v1") return null
  const required = ["activeGoals", "fixedConstraints", "steering", "revisions", "unresolved", "waits", "approvals", "verifiedEvidence", "artifacts", "taskRefs", "eventRefs", "omittedRanges", "coveredSequence"]
  if (required.some(field => value[field] === undefined)) return null
  if (own(value, "decisions") && value.decisions === undefined || own(value, "unresolvedQuestions") && value.unresolvedQuestions === undefined) return null
  const activeGoals = anchors(value.activeGoals), fixedConstraints = anchors(value.fixedConstraints), steering = anchors(value.steering)
  const unresolved = references(value.unresolved), waits = references(value.waits), approvals = references(value.approvals), verifiedEvidence = references(value.verifiedEvidence), artifacts = references(value.artifacts), taskRefs = references(value.taskRefs), eventRefs = references(value.eventRefs), omittedRanges = ranges(value.omittedRanges)
  const decisions = narratives(value.decisions === undefined ? [] : value.decisions, false), unresolvedQuestions = narratives(value.unresolvedQuestions === undefined ? [] : value.unresolvedQuestions, true)
  if (!activeGoals || !fixedConstraints || !steering || !unresolved || !waits || !approvals || !verifiedEvidence || !artifacts || !taskRefs || !eventRefs || !omittedRanges || !decisions || !unresolvedQuestions || !plain(value.revisions) || !keys(value.revisions, ["goalRevision", "planRevision"])) return null
  const goalRevision: number | null | undefined = value.revisions.goalRevision === null ? null : revision(value.revisions.goalRevision) ? value.revisions.goalRevision : undefined
  const planRevision: number | null | undefined = value.revisions.planRevision === null ? null : revision(value.revisions.planRevision) ? value.revisions.planRevision : undefined
  if (goalRevision === undefined || planRevision === undefined || value.coveredSequence !== null && parseSequence(value.coveredSequence) === null || value.coveredSequence === undefined) return null
  if (options.expectedGoalRevision !== undefined && (!revision(options.expectedGoalRevision) || (goalRevision !== null && goalRevision > options.expectedGoalRevision))) return null
  if (options.expectedPlanRevision !== undefined && !revision(options.expectedPlanRevision) || options.expectedPlanRevision !== undefined && planRevision !== null && planRevision > options.expectedPlanRevision) return null
  const covered = value.coveredSequence === null ? null : BigInt(value.coveredSequence as string)
  const allRefs = [...unresolved, ...waits, ...approvals, ...verifiedEvidence, ...artifacts, ...taskRefs, ...eventRefs]
  if (covered === null && allRefs.some(item => item.sequence !== undefined)) return null
  if (covered !== null && allRefs.some(item => item.sequence !== undefined && BigInt(item.sequence) > covered)) return null
  const expectedGoalRevision = options.expectedGoalRevision
  const narrativesAll = [...decisions, ...unresolvedQuestions]
  if (goalRevision === null && allRefs.some(item => item.goalRevision !== undefined)) return null
  if (planRevision === null && allRefs.some(item => item.planRevision !== undefined && (item.goalRevision === undefined || goalRevision === null || item.goalRevision === goalRevision))) return null
  if (expectedGoalRevision !== undefined && allRefs.some(item => item.goalRevision !== undefined && item.goalRevision > expectedGoalRevision)) return null
  if (goalRevision !== null && allRefs.some(item => item.goalRevision !== undefined && item.goalRevision > goalRevision) || planRevision !== null && allRefs.some(item => item.planRevision !== undefined && (item.goalRevision === undefined || item.goalRevision === goalRevision) && item.planRevision > planRevision)) return null
  if (goalRevision === null && narrativesAll.length > 0 || planRevision === null && decisions.length > 0 || planRevision === null && unresolvedQuestions.some(item => item.planRevision !== undefined)) return null
  if (planRevision !== null && narrativesAll.some(item => item.planRevision !== undefined && item.planRevision > planRevision)) return null
  if (options.expectedGoalRevision !== undefined && narrativesAll.some(item => item.goalRevision > options.expectedGoalRevision!)) return null
  if (options.expectedPlanRevision !== undefined && narrativesAll.some(item => item.planRevision !== undefined && item.planRevision > options.expectedPlanRevision!)) return null
  const expectedPlanRevision = options.expectedPlanRevision
  const scoped = (values: readonly CognitiveMemoryReference[]): readonly CognitiveMemoryReference[] => expectedGoalRevision === undefined
    ? values
    : values.filter(item => item.goalRevision === undefined || item.goalRevision === expectedGoalRevision && (expectedPlanRevision === undefined || item.planRevision === undefined || item.planRevision === expectedPlanRevision))
  const scopedNarrative = <T extends CognitiveMemoryDecision | CognitiveMemoryQuestion>(values: readonly T[]): readonly T[] => expectedPlanRevision === undefined ? values : values.filter(item => item.planRevision === undefined || item.planRevision === expectedPlanRevision)
  const result: ContextMemoryProjection = { schemaVersion: "agent-harness.cognitive-memory.v1", activeGoals, fixedConstraints, steering, revisions: { goalRevision, planRevision }, decisions: scopedNarrative(decisions) as CognitiveMemoryDecision[], unresolvedQuestions: scopedNarrative(unresolvedQuestions) as CognitiveMemoryQuestion[], unresolved: scoped(unresolved), waits: scoped(waits), approvals: scoped(approvals), verifiedEvidence: scoped(verifiedEvidence), artifacts: scoped(artifacts), taskRefs: scoped(taskRefs), eventRefs: scoped(eventRefs), omittedRanges, coveredSequence: value.coveredSequence as string | null }
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= maxBytes ? result : null
}

export type ContextMemoryNarrative = { readonly decisions: readonly CognitiveMemoryDecision[]; readonly unresolvedQuestions: readonly CognitiveMemoryQuestion[] }
export function deriveContextMemoryNarrative(observations: readonly Observation[], expectedGoalRevision: number | null, expectedPlanRevision?: number): ContextMemoryNarrative {
  if (expectedGoalRevision === null) return { decisions: [], unresolvedQuestions: [] }
  const decisions = new Map<string, CognitiveMemoryDecision>(), questions = new Map<string, CognitiveMemoryQuestion>()
  for (const observation of observations) {
    const content = plain(observation.content) ? observation.content : null
    if (!content) continue
    if (content.kind === "plan_revision" && observation.id.startsWith("plan-revision:") && revision(content.goalRevision) && revision(content.planRevision) && content.goalRevision === expectedGoalRevision) decisions.set(`decision:${observation.id}`, { id: `decision:${observation.id}`, summary: `Accepted plan revision ${content.planRevision} for goal revision ${content.goalRevision}`, sourceRef: observation.id, goalRevision: content.goalRevision, planRevision: content.planRevision })
    const goalRevision: number | undefined = revision(content.goalRevision) ? content.goalRevision : undefined
    const planRevision: number | undefined = revision(content.planRevision) ? content.planRevision : undefined
    if (goalRevision !== expectedGoalRevision || !planRevision) continue
    if (expectedPlanRevision !== undefined && planRevision !== expectedPlanRevision) continue
    if (content.kind === "wait_result" && content.status === "waiting") questions.set(`question:${observation.id}`, { id: `question:${observation.id}`, summary: "A child task result is still pending", sourceRef: observation.id, goalRevision, planRevision })
    if (content.kind === "approval" && content.status === "pending") questions.set(`question:${observation.id}`, { id: `question:${observation.id}`, summary: "Approval is required before continuing", sourceRef: observation.id, goalRevision, planRevision })
  }
  return { decisions: [...decisions.values()].sort((left, right) => left.id.localeCompare(right.id)), unresolvedQuestions: [...questions.values()].sort((left, right) => left.id.localeCompare(right.id)) }
}
