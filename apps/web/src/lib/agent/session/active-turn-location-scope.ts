import type { CommandTransaction } from "../control-plane/commands/transaction"
import { readActiveTurnLocationAcceptances, type ActiveTurnLocationAcceptance, type ActiveTurnLocationScope } from "./active-turn-location-acceptance"
import { readActiveTurnLocationPlanProofs, type ActiveTurnLocationPlanProof } from "./active-turn-location-plan-proof"

export type ActiveTurnLocationScopeProjection = Readonly<{
  confirmed: Readonly<{ locations: readonly string[]; status: "pending" | "adopted" }>
  appliedLocations?: readonly string[]
}>

export function projectActiveTurnLocationScope(
  acceptances: readonly ActiveTurnLocationAcceptance[], proofs: ReadonlyMap<string, ActiveTurnLocationPlanProof>,
): ActiveTurnLocationScopeProjection | null {
  const latest = acceptances[acceptances.length - 1]
  if (!latest) return null
  let applied: readonly string[] | undefined
  let adopted = false
  for (const acceptance of acceptances) {
    const proof = proofs.get(acceptance.inputId)
    if (proof === "revise") {
      applied = acceptance.locations
      if (acceptance.inputId === latest.inputId) adopted = true
    } else if (proof === "keep" && applied && sameLocations(applied, acceptance.locations)
      && acceptance.inputId === latest.inputId) adopted = true
  }
  return { confirmed: { locations: latest.locations, status: adopted ? "adopted" : "pending" }, ...(applied ? { appliedLocations: applied } : {}) }
}

export async function readActiveTurnLocationScope(
  tx: CommandTransaction, scope: ActiveTurnLocationScope,
): Promise<ActiveTurnLocationScopeProjection | null> {
  let acceptances: ActiveTurnLocationAcceptance[]
  try { acceptances = await readActiveTurnLocationAcceptances(tx, scope) } catch { return null }
  if (!acceptances.length) return null
  let proofs: ReadonlyMap<string, ActiveTurnLocationPlanProof> = new Map()
  try { proofs = await readActiveTurnLocationPlanProofs(tx, scope, acceptances) } catch { /* A verified confirmation remains pending without plan proof. */ }
  return projectActiveTurnLocationScope(acceptances, proofs)
}

function sameLocations(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((location, index) => location === right[index])
}
