import { parseObjectiveTailorGraph } from "@jobcopilot/agent-protocol"

export const OBJECTIVE_TAILOR_WAVE_VIEW_SCHEMA = "agent-harness.v2.objective-tailor-wave-view.v1" as const
type Status = "queued" | "running" | "retrying" | "waiting" | "waiting_for_user" | "completed" | "failed" | "interrupted" | "cancelled" | "closed"
type Readiness = "ready" | "waiting_for_dependencies" | "blocked_dependency" | "active" | "terminal"
type Child = Readonly<{ taskId: string; status: Status; readiness: Readiness }>
export type ObjectiveTailorWaveView = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_WAVE_VIEW_SCHEMA
  graphRevision: number
  sourceNodeCount: number
  ordinaryPlanAppend: "closed"
  slots: readonly Readonly<{
    slotId: string; sourceAnalystNodeKey: string; effectivePair: "initial" | "correction"
    initial: Readonly<{ writer: Child; reviewer: Child }>
    correction?: Readonly<{ writer: Child; reviewer: Child }>
  }>[]
}>
export type ObjectiveTailorWaveProjection =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "valid"; sourceNodeCount: number; view: ObjectiveTailorWaveView }>

const STATUSES = new Set<Status>(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const READINESS = new Set<Readiness>(["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"])

/** Validates the server-read marker against every current row, then drops all proof and prose. */
export function projectObjectiveTailorWaveView(value: unknown): ObjectiveTailorWaveProjection {
  const state = record(value)
  if (!state) return { status: "invalid" }
  const markerField = own(state, "objectiveTailor")
  if (markerField.status === "absent") return { status: "absent" }
  if (markerField.status !== "value") return { status: "invalid" }
  const revision = own(state, "revision"), rawNodes = own(state, "nodes"), eligibility = own(state, "discoveryTurnEligibility")
  if (eligibility.status !== "value" || eligibility.value !== "ordinary"
    || revision.status !== "value" || !integer(revision.value, 1) || rawNodes.status !== "value") return { status: "invalid" }
  const nodes = dense(rawNodes.value, 40)
  const marker = record(markerField.value), sourceCount = marker && own(marker, "sourceNodeCount")
  if (!nodes || !marker || sourceCount?.status !== "value" || !integer(sourceCount.value, 2)) return { status: "invalid" }
  const structuralNodes = nodes.map((value, index) => {
    const row = record(value), key = row && own(row, "key"), templateId = row && own(row, "templateId"), dependsOn = row && own(row, "dependsOn")
    if (key?.status !== "value" || templateId?.status !== "value" || dependsOn?.status !== "value") return null
    const typed = own(row!, "verification").status === "value" && own(row!, "verificationCriterionIds").status === "value"
    return { key: key.value, templateId: templateId.value, dependsOn: dependsOn.value,
      verificationDisposition: index < Number(sourceCount.value) ? typed ? "typed" : "legacy_unverified" : "specialized" }
  })
  if (structuralNodes.some(node => node === null)) return { status: "invalid" }
  const parsed = parseObjectiveTailorGraph(markerField.value, structuralNodes)
  if (!parsed) return { status: "invalid" }
  const byKey = new Map<string, Record<string, unknown>>()
  const taskIds = new Set<string>()
  for (const value of nodes) {
    const row = record(value), key = row && own(row, "key"), taskId = row && own(row, "taskId")
    if (!row || key?.status !== "value" || typeof key.value !== "string" || byKey.has(key.value)
      || taskId?.status !== "value" || !safeId(taskId.value) || taskIds.has(taskId.value)) return { status: "invalid" }
    byKey.set(key.value, row)
    taskIds.add(taskId.value)
  }
  const slots = parsed.slots.map(slot => {
    const initialWriter = child(byKey.get(slot.writerNodeKey)), initialReviewer = child(byKey.get(slot.reviewerNodeKey))
    const correctionWriter = slot.correction ? child(byKey.get(slot.correction.writerNodeKey)) : undefined
    const correctionReviewer = slot.correction ? child(byKey.get(slot.correction.reviewerNodeKey)) : undefined
    if (!initialWriter || !initialReviewer || slot.correction && (!correctionWriter || !correctionReviewer)) return null
    return { slotId: slot.slotId, sourceAnalystNodeKey: slot.sourceAnalystNodeKey,
      effectivePair: slot.correction ? "correction" as const : "initial" as const,
      initial: { writer: initialWriter, reviewer: initialReviewer },
      ...(correctionWriter && correctionReviewer ? { correction: { writer: correctionWriter, reviewer: correctionReviewer } } : {}) }
  })
  if (slots.some(slot => slot === null)) return { status: "invalid" }
  return { status: "valid", sourceNodeCount: parsed.sourceNodeCount, view: {
    schemaVersion: OBJECTIVE_TAILOR_WAVE_VIEW_SCHEMA, graphRevision: Number(revision.value),
    sourceNodeCount: parsed.sourceNodeCount, ordinaryPlanAppend: "closed", slots: slots as NonNullable<(typeof slots)[number]>[],
  } }
}

/** Keeps only the first bounded intent for each owner-read source-prefix key. */
export function projectObjectiveTailorWaveSourceIntent(value: unknown, sourceKeys: ReadonlySet<string>): readonly unknown[] {
  const rows = dense(value, 40)
  if (!rows) return []
  const seen = new Set<string>(), result: unknown[] = []
  for (const item of rows) {
    const row = record(item), key = row && own(row, "nodeKey")
    if (key?.status !== "value" || typeof key.value !== "string" || !sourceKeys.has(key.value) || seen.has(key.value)) continue
    seen.add(key.value); result.push(item)
  }
  return result
}

function child(value: Record<string, unknown> | undefined): Child | undefined {
  const taskId = value && own(value, "taskId"), status = value && own(value, "status"), readiness = value && own(value, "readiness")
  return taskId?.status === "value" && safeId(taskId.value) && status?.status === "value" && isStatus(status.value)
    && readiness?.status === "value" && isReadiness(readiness.value) && readinessMatches(status.value, readiness.value)
    ? { taskId: taskId.value, status: status.value, readiness: readiness.value } : undefined
}
function readinessMatches(status: Status, readiness: Readiness): boolean {
  if (["completed", "failed", "interrupted", "cancelled", "closed"].includes(status)) return readiness === "terminal"
  if (status === "queued" || status === "waiting") return readiness !== "active" && readiness !== "terminal"
  return readiness === "active"
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}
type Own = Readonly<{ status: "absent" }> | Readonly<{ status: "invalid" }> | Readonly<{ status: "value"; value: unknown }>
function own(row: Record<string, unknown>, key: string): Own {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    if (!descriptor) return { status: "absent" }
    return descriptor.enumerable && "value" in descriptor ? { status: "value", value: descriptor.value } : { status: "invalid" }
  } catch { return { status: "invalid" } }
}
function dense(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) return undefined
    const rows: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
      rows.push(descriptor.value)
    }
    return rows
  } catch { return undefined }
}
function integer(value: unknown, minimum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum }
function safeId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128 }
function isStatus(value: unknown): value is Status { return typeof value === "string" && STATUSES.has(value as Status) }
function isReadiness(value: unknown): value is Readiness { return typeof value === "string" && READINESS.has(value as Readiness) }
