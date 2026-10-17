import { Buffer } from "node:buffer"

import type { CognitiveAction, CognitiveAgendaBlocker } from "./cognitive-action-agenda.js"
import { parseCognitiveAgendaReceipt, type CognitiveAgendaReceiptScope } from "./cognitive-agenda-receipt.js"

const MAX_PROJECTED_COUNT = 999
const MAX_CONTEXT_BYTES = 512

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
}

/** Revalidates the durable receipt for one exact request scope and drops all IDs and text. */
export function projectCognitiveAgendaContext(value: unknown, expected: CognitiveAgendaReceiptScope): CognitiveAgendaContext | null {
  const receipt = parseCognitiveAgendaReceipt(value, expected)
  if (!receipt) return null
  const count = (signal: { readonly count: number }) => Math.min(signal.count, MAX_PROJECTED_COUNT)
  const projection: CognitiveAgendaContext = {
    nextAction: receipt.nextAction,
    blockedBy: receipt.blockedBy.kind,
    goalRevision: receipt.goalRevision,
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
  }
  const encoded = JSON.stringify(projection)
  return encoded && Buffer.byteLength(encoded, "utf8") <= MAX_CONTEXT_BYTES ? projection : null
}
