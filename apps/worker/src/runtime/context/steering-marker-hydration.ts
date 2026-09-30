import { InputClaimStoreError, type StoredAgentInput } from "./input-claim-store.js"
import { parseSteeringMarkerPayload, type SteeringMarkerPayload } from "./steering-marker.js"

export type SteeringMarkerHydrationScope = {
  readonly sessionId: string
  readonly turnId: string
  readonly taskId: string
  readonly obligationId?: string
  readonly goalRevision?: number
  readonly planRevision?: number | null
}

export function activeMarkerInputIds(markers: readonly SteeringMarkerPayload[] | undefined, rootInputId?: string, scope?: SteeringMarkerHydrationScope): readonly string[] {
  if (markers === undefined) return []
  if (!Array.isArray(markers) || markers.length > 128) throw new InputClaimStoreError("store_conflict", "Active steering marker state is invalid")
  if (markers.length > 0 && (!scope || !scope.sessionId || !scope.turnId || !scope.taskId)) throw new InputClaimStoreError("store_conflict", "Active steering marker scope is missing")
  const ids = markers.map(marker => {
    const parsed = parseSteeringMarkerPayload(marker)
    if (!parsed || parsed.kind !== "observed" || parsed.status !== "observed") throw new InputClaimStoreError("store_conflict", "Active steering marker state is invalid")
    if (parsed.inputId === rootInputId) throw new InputClaimStoreError("store_conflict", "Root input cannot have a steering marker")
    if (scope && (parsed.sessionId !== scope.sessionId || parsed.turnId !== scope.turnId || parsed.taskId !== scope.taskId || scope.obligationId !== undefined && parsed.obligationId !== scope.obligationId || scope.goalRevision !== undefined && parsed.goalRevision !== scope.goalRevision || scope.planRevision !== undefined && parsed.planRevision !== scope.planRevision)) throw new InputClaimStoreError("store_conflict", "Active steering marker is outside the fenced Turn")
    return parsed.inputId
  })
  if (new Set(ids).size !== ids.length) throw new InputClaimStoreError("store_conflict", "Active steering marker inputs are duplicated")
  return [...ids].sort()
}

export function assertHydratedSteeringInputs(inputIds: readonly string[], inputs: readonly StoredAgentInput[]): void {
  if (inputs.length !== inputIds.length || new Set(inputs.map(input => input.id)).size !== inputIds.length || inputIds.some(inputId => !inputs.some(input => input.id === inputId)) || inputs.some(input => input.status !== "consumed" || input.consumedByStepId === null)) {
    throw new InputClaimStoreError("store_conflict", "Active steering marker input is not durably consumed")
  }
}

export function mergeSteeringInputs(claimed: readonly StoredAgentInput[], hydrated: readonly StoredAgentInput[]): StoredAgentInput[] {
  const byId = new Map<string, StoredAgentInput>()
  for (const input of [...claimed, ...hydrated]) byId.set(input.id, input)
  return [...byId.values()].sort((left, right) => left.acceptedSequence < right.acceptedSequence ? -1 : left.acceptedSequence > right.acceptedSequence ? 1 : left.id.localeCompare(right.id))
}
