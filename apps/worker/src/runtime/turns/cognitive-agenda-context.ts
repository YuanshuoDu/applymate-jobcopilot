import { Buffer } from "node:buffer"

import type { CognitiveAction, CognitiveAgendaBlocker } from "./cognitive-action-agenda.js"
import { COGNITIVE_AGENDA_RECEIPT_V2_SCHEMA_VERSION, parseCognitiveAgendaReceipt,
  type CognitiveAgendaReceiptScope } from "./cognitive-agenda-receipt.js"
import type { ObjectiveProgressDelta, ObjectiveProgressSnapshot } from "../context/task-graph-objective-progress-delta.js"

const MAX_PROJECTED_COUNT = 999
const MAX_PROJECTED_REQUIREMENTS = 8
const MAX_CONTEXT_BYTES = 4 * 1024

type ProjectedObjectiveProgressRequirement = ObjectiveProgressDelta["requirements"][number] & {
  readonly objectiveRequirementPosition?: number
}
type ProjectedObjectiveProgressDelta = Omit<ObjectiveProgressDelta, "requirements"> & {
  readonly requirements: readonly ProjectedObjectiveProgressRequirement[]
}

function snapshotMatchesDelta(delta: ObjectiveProgressDelta, snapshot: ObjectiveProgressSnapshot): boolean {
  return delta.requirements.length === snapshot.requirements.length && delta.requirements.every((row, index) => {
    const current = snapshot.requirements[index]
    if (!current || row.id !== current.id || row.kind !== current.kind || row.afterStatus !== current.status) return false
    return row.kind === "candidate_location_in" ? current.kind === "candidate_location_in"
      : current.kind !== "candidate_location_in" && row.minimum === current.minimum
  })
}

function projectProgressDelta(delta: ObjectiveProgressDelta, snapshot: ObjectiveProgressSnapshot | null): ProjectedObjectiveProgressDelta | null {
  const snapshotById = new Map(snapshot?.requirements.map(row => [row.id, row]) ?? [])
  const locations = new Set(snapshot?.requirements.flatMap(row => row.kind === "candidate_location_in" ? row.locations : []) ?? [])
  const hasAnonymousRows = delta.requirements.some(row => row.kind === "candidate_location_in" || locations.has(row.id))
  if (hasAnonymousRows && (!snapshot || !snapshotMatchesDelta(delta, snapshot))) return null
  const forbidden = new Set([...delta.requirements.map(row => row.id), ...(snapshot?.requirements.map(row => row.id) ?? []), ...locations])
  let nextLocationId = 1
  const requirements: ProjectedObjectiveProgressRequirement[] = []
  for (const [index, row] of delta.requirements.entries()) {
    if (row.kind === "candidate_location_in") {
      const current = snapshotById.get(row.id)
      if (!current || current.kind !== "candidate_location_in" || current.status !== row.afterStatus) return null
    }
    let id = row.id
    if (row.kind === "candidate_location_in" || locations.has(row.id)) {
      let anonymousId: string | undefined
      for (let attempt = 0; attempt <= forbidden.size + delta.requirements.length; attempt += 1) {
        const candidate = "location_requirement_" + nextLocationId++
        if (!forbidden.has(candidate)) { anonymousId = candidate; break }
      }
      if (!anonymousId) return null
      forbidden.add(anonymousId)
      id = anonymousId
    }
    const projected = { ...row, id }
    const position = index + 1
    if (hasAnonymousRows && position > MAX_PROJECTED_REQUIREMENTS) return null
    requirements.push(hasAnonymousRows ? { ...projected, objectiveRequirementPosition: position } : projected)
  }
  return { ...delta, requirements }
}

export type CognitiveAgendaContext = {
  readonly nextAction: CognitiveAction
  readonly blockedBy: CognitiveAgendaBlocker | null
  readonly goalRevision: number | null
  readonly planRevision: number | null
  readonly signals: {
    readonly pendingInputs: number
    readonly approvals: number
    readonly activeWaits: number
    readonly unresolved: number
    readonly completionVerification: number
    readonly activeSteering: number
    readonly newlyObservedSteering: number
  }
  readonly steering: { readonly present: boolean; readonly fresh: boolean }
  readonly progressDelta?: ProjectedObjectiveProgressDelta
}

/** Revalidates the durable receipt for one exact request scope and drops all IDs and text. */
export function projectCognitiveAgendaContext(value: unknown, expected: CognitiveAgendaReceiptScope): CognitiveAgendaContext | null {
  const receipt = parseCognitiveAgendaReceipt(value, expected)
  if (!receipt) return null
  const count = (signal: { readonly count: number }) => Math.min(signal.count, MAX_PROJECTED_COUNT)
  const progressDelta = receipt.schemaVersion === COGNITIVE_AGENDA_RECEIPT_V2_SCHEMA_VERSION
    ? projectProgressDelta(receipt.progressDelta, receipt.objectiveProgressSnapshot) : undefined
  if (receipt.schemaVersion === COGNITIVE_AGENDA_RECEIPT_V2_SCHEMA_VERSION && !progressDelta) return null
  const projection: CognitiveAgendaContext = {
    nextAction: receipt.nextAction,
    blockedBy: receipt.blockedBy.kind,
    goalRevision: receipt.schemaVersion === COGNITIVE_AGENDA_RECEIPT_V2_SCHEMA_VERSION ? null : receipt.goalRevision,
    planRevision: receipt.planRevision,
    signals: {
      pendingInputs: count(receipt.signals.pendingInputs),
      approvals: count(receipt.signals.approvals),
      activeWaits: count(receipt.signals.activeWaits),
      unresolved: count(receipt.signals.unresolved),
      completionVerification: count(receipt.signals.completionVerification),
      activeSteering: count(receipt.signals.steering.active),
      newlyObservedSteering: count(receipt.signals.steering.newlyObserved),
    },
    steering: { present: receipt.signals.steering.present, fresh: receipt.signals.steering.fresh },
    ...(progressDelta ? { progressDelta } : {}),
  }
  const encoded = JSON.stringify(projection)
  return encoded && Buffer.byteLength(encoded, "utf8") <= MAX_CONTEXT_BYTES ? projection : null
}
