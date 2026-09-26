import type { CommandDisposition } from "./types"
import type { CommandTransaction } from "./transaction"

export interface ExistingCommand {
  id: string
  targetTurnId: string | null
  delivery: string
  acceptedSequence: bigint
}

export async function findExistingCommand(
  tx: CommandTransaction,
  sessionId: string,
  clientMessageId: string,
): Promise<ExistingCommand | null> {
  return tx.agentInput.findFirst({
    where: { sessionId, clientMessageId },
    select: { id: true, targetTurnId: true, delivery: true, acceptedSequence: true },
  })
}

export function fallbackDisposition(
  existing: ExistingCommand,
  requestedDelivery: "steer" | "follow_up",
): Exclude<CommandDisposition, "duplicate"> {
  if (existing.delivery === "steer" || requestedDelivery === "steer") return "steered"
  return existing.targetTurnId ? "queued_follow_up" : "started"
}
