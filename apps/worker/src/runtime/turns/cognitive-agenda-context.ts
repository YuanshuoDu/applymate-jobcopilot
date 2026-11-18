import { Buffer } from "node:buffer"

import type { CognitiveAction, CognitiveAgendaBlocker } from "./cognitive-action-agenda.js"
import { COGNITIVE_AGENDA_RECEIPT_V2_SCHEMA_VERSION, parseCognitiveAgendaReceipt,
  type CognitiveAgendaReceiptScope } from "./cognitive-agenda-receipt.js"
import type { ObjectiveProgressDelta, ObjectiveProgressSnapshot } from "../context/task-graph-objective-progress-delta.js"

const MAX_PROJECTED_COUNT = 999
const MAX_CONTEXT_BYTES = 4 * 1024

function projectProgressDelta(delta: ObjectiveProgressDelta, snapshot: ObjectiveProgressSnapshot | null): ObjectiveProgressDelta | null {
  const locationRows = delta.requirements.filter(row => row.kind === "candidate_location_in")
  if (locationRows.length && !snapshot) return null
  const snapshotById = new Map(snapshot?.requirements.map(row => [row.id, row]) ?? [])
  const locations = new Set(snapshot?.requirements.flatMap(row => row.kind === "candidate_location_in" ? row.locations : []) ?? [])
  const forbidden = new Set([...delta.requirements.map(row => row.id), ...locations])
  let nextLocationId = 1
  const requirements = delta.requirements.map(row => {
    if (row.kind === "candidate_location_in") {
      const current = snapshotById.get(row.id)
      if (!current || current.kind !== "candidate_location_in" || current.status !== row.afterStatus) return null
    }
    if (row.kind !== "candidate_location_in" && !locations.has(row.id)) return row
    let id: string | undefined
    for (let attempt = 0; attempt <= forbidden.size + delta.requirements.length; attempt += 1) {
      const candidate = "location_requirement_" + nextLocationId++
      if (!forbidden.has(candidate)) { id = candidate; break }
    }
    if (!id) return null
    forbidden.add(id)
    return { ...row, id }
  })
  if (requirements.some(row => row === null)) return null
  return { ...delta, requirements: requirements as ObjectiveProgressDelta["requirements"] }
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
  readonly progressDelta?: ObjectiveProgressDelta
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
