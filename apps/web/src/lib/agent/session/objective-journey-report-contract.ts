export const OBJECTIVE_JOURNEY_REPORT_SCHEMA = "agent-harness.v2.objective-journey-report.v1" as const

export const OBJECTIVE_JOURNEY_TAILORING_STATUSES = ["ready", "needs_revision", "rejected", "stale", "failed"] as const
export const OBJECTIVE_JOURNEY_REVIEW_STATUSES = ["not_requested", "pending", "approved", "rejected", "expired", "unknown"] as const
export const OBJECTIVE_JOURNEY_APPLICATION_STATUSES = ["not_started", "preparing", "awaiting_submit_approval", "submitted", "uncertain", "failed", "unknown"] as const
export const OBJECTIVE_JOURNEY_RETIREMENT_REASONS = ["approval_ttl_reached", "approval_revision_changed", "resume_witness_unavailable", "resume_material_changed", "completed_source_changed"] as const
const COVERAGES = ["complete", "partial", "unavailable", "not_requested"] as const
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export type ObjectiveJourneyReport = Readonly<{
  schemaVersion: typeof OBJECTIVE_JOURNEY_REPORT_SCHEMA
  finalItemId: string
  graphRevision: number
  sourceCounts: Readonly<{ discoveredJobs: Count; analyzedJobs: Count }>
  reviewCoverage: "complete" | "partial" | "unavailable"
  slots: readonly Slot[]
}>
type Coverage = typeof COVERAGES[number]
type Count = Readonly<{ knownCount: number | null; coverage: Coverage }>
type Slot = Readonly<{
  ordinal: number
  tailoringStatus: typeof OBJECTIVE_JOURNEY_TAILORING_STATUSES[number]
  job: Readonly<{ company: string; role: string }> | null
  reviewStatus: typeof OBJECTIVE_JOURNEY_REVIEW_STATUSES[number]
  reviewTurnId: string | null
  retirementReason: typeof OBJECTIVE_JOURNEY_RETIREMENT_REASONS[number] | null
  applicationStatus: typeof OBJECTIVE_JOURNEY_APPLICATION_STATUSES[number]
  submissionEvidence: Readonly<{ fillTurnId: string; finalItemId: string }> | null
}>

/** Accepts only the bounded owner-facing report DTO; it carries no proof or mutation authority. */
export function parseObjectiveJourneyReport(value: unknown): ObjectiveJourneyReport | undefined {
  const row = record(value)
  if (!row || !exact(row, "finalItemId,graphRevision,reviewCoverage,schemaVersion,slots,sourceCounts")
    || row.schemaVersion !== OBJECTIVE_JOURNEY_REPORT_SCHEMA || !id(row.finalItemId) || !positive(row.graphRevision)
    || !oneOf(row.reviewCoverage, ["complete", "partial", "unavailable"])) return undefined
  const counts = record(row.sourceCounts), slots = dense(row.slots)
  if (!counts || !exact(counts, "analyzedJobs,discoveredJobs") || !slots) return undefined
  const discoveredJobs = parseCount(counts.discoveredJobs), analyzedJobs = parseCount(counts.analyzedJobs)
  if (!discoveredJobs || !analyzedJobs) return undefined
  const parsed: Slot[] = []
  const fills = new Set<string>(), finalItems = new Set<string>()
  for (let index = 0; index < slots.length; index += 1) {
    const slot = parseSlot(slots[index], index + 1, row.finalItemId)
    if (!slot) return undefined
    if (slot.submissionEvidence && (fills.has(slot.submissionEvidence.fillTurnId) || finalItems.has(slot.submissionEvidence.finalItemId))) return undefined
    if (slot.submissionEvidence) {
      fills.add(slot.submissionEvidence.fillTurnId); finalItems.add(slot.submissionEvidence.finalItemId)
    }
    parsed.push(slot)
  }
  if (row.reviewCoverage === "complete" && parsed.some(slot => slot.reviewStatus === "unknown")) return undefined
  return { schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA, finalItemId: row.finalItemId,
    graphRevision: Number(row.graphRevision), sourceCounts: { discoveredJobs, analyzedJobs },
    reviewCoverage: row.reviewCoverage, slots: parsed }
}

function parseSlot(value: unknown, ordinal: number, sourceFinalItemId: string): Slot | undefined {
  const row = record(value)
  if (!row || !exact(row, "applicationStatus,job,ordinal,retirementReason,reviewStatus,reviewTurnId,submissionEvidence,tailoringStatus")
    || row.ordinal !== ordinal || !oneOf(row.tailoringStatus, OBJECTIVE_JOURNEY_TAILORING_STATUSES)
    || !oneOf(row.reviewStatus, OBJECTIVE_JOURNEY_REVIEW_STATUSES) || !oneOf(row.applicationStatus, OBJECTIVE_JOURNEY_APPLICATION_STATUSES)
    || !(row.reviewTurnId === null || id(row.reviewTurnId))
    || !(row.retirementReason === null || oneOf(row.retirementReason, OBJECTIVE_JOURNEY_RETIREMENT_REASONS))) return undefined
  const job = row.job === null ? null : parseJob(row.job)
  const submissionEvidence = row.submissionEvidence === null ? null : parseSubmissionEvidence(row.submissionEvidence)
  if (row.job !== null && !job || row.submissionEvidence !== null && !submissionEvidence
    || row.reviewStatus === "not_requested" && row.reviewTurnId !== null
    || ["pending", "approved", "rejected", "expired"].includes(String(row.reviewStatus)) && row.reviewTurnId === null
    || row.retirementReason !== null && row.reviewStatus !== "expired"
    || (row.applicationStatus === "submitted") !== (submissionEvidence !== null)
    || submissionEvidence?.finalItemId === sourceFinalItemId
    || ["preparing", "awaiting_submit_approval", "submitted", "uncertain", "failed"].includes(String(row.applicationStatus))
      && (row.tailoringStatus !== "ready" || row.reviewStatus !== "approved")) return undefined
  return { ordinal, tailoringStatus: row.tailoringStatus, job: job ?? null, reviewStatus: row.reviewStatus,
    reviewTurnId: row.reviewTurnId, retirementReason: row.retirementReason,
    applicationStatus: row.applicationStatus, submissionEvidence: submissionEvidence ?? null }
}

function parseJob(value: unknown): Slot["job"] | undefined {
  const row = record(value)
  return row && exact(row, "company,role") && text(row.company, 160) && text(row.role, 160)
    ? { company: row.company, role: row.role } : undefined
}

function parseSubmissionEvidence(value: unknown): NonNullable<Slot["submissionEvidence"]> | undefined {
  const row = record(value)
  return row && exact(row, "fillTurnId,finalItemId") && id(row.fillTurnId) && id(row.finalItemId)
    ? { fillTurnId: row.fillTurnId, finalItemId: row.finalItemId } : undefined
}

function parseCount(value: unknown): Count | undefined {
  const row = record(value)
  if (!row || !exact(row, "coverage,knownCount") || !oneOf(row.coverage, COVERAGES)) return undefined
  const knownCount = row.knownCount
  return row.coverage === "complete" || row.coverage === "partial"
    ? nonnegative(knownCount) ? { coverage: row.coverage, knownCount } : undefined
    : knownCount === null ? { coverage: row.coverage, knownCount: null } : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
    if (keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}

function exact(row: Record<string, unknown>, csv: string): boolean {
  const expected = csv.split(","), keys = Reflect.ownKeys(row)
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
}

function dense(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 8) return undefined
  try {
    if (Reflect.ownKeys(value).length !== value.length + 1) return undefined
    const rows: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined
      rows.push(descriptor.value)
    }
    return rows
  } catch { return undefined }
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T)
}
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value) && value.trim() === value }
function text(value: unknown, limit: number): value is string { return idText(value, limit) && value.trim() === value }
function idText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
