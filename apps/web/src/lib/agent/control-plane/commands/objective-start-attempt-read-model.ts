import { createHash } from "node:crypto"
import type { PrismaClient } from "@prisma/client"

import type { ObjectiveStartAttemptState, ObjectiveStartReceipt } from "./objective-start-attempt-ledger"

type ReceiptTargetDatabase = Pick<PrismaClient, "agentSession">

export function taskRecoveryAccountScope(userId: string): string {
  return createHash("sha256").update(`applymate:task-start-recovery:${userId}`).digest("hex")
}

export async function objectiveStartReceiptTargetExists(
  db: ReceiptTargetDatabase,
  userId: string,
  receipt: ObjectiveStartReceipt,
): Promise<boolean> {
  const session = await db.agentSession.findFirst({
    where: {
      id: receipt.sessionId,
      userId,
      turns: { some: { id: receipt.turnId, userId } },
    },
    select: { id: true },
  })
  return session !== null
}

export async function stateWithAvailableReceiptTarget(
  db: ReceiptTargetDatabase,
  userId: string,
  state: ObjectiveStartAttemptState,
): Promise<ObjectiveStartAttemptState> {
  if (state.state !== "accepted") return state
  return await objectiveStartReceiptTargetExists(db, userId, state.receipt) ? state : { state: "unavailable" }
}

export async function listObjectiveStartAttempts(db: PrismaClient, userId: string, limit: number) {
  const rows = await db.agentObjectiveStartAttempt.findMany({
    where: { userId }, orderBy: { createdAt: "desc" }, take: limit,
    select: { clientMessageId: true, status: true, sessionId: true, inputId: true, turnId: true, acceptedSequence: true, createdAt: true, updatedAt: true },
  })
  return {
    accountScope: taskRecoveryAccountScope(userId),
    attempts: await Promise.all(rows.map(async (row) => {
      const receipt = row.status === "accepted"
        && typeof row.sessionId === "string" && typeof row.inputId === "string" && typeof row.turnId === "string"
        && row.acceptedSequence !== null
        ? { sessionId: row.sessionId, inputId: row.inputId, turnId: row.turnId, sequence: row.acceptedSequence.toString() }
        : null
      const available = receipt ? await objectiveStartReceiptTargetExists(db, userId, receipt) : false
      const state = row.status === "abandoned" ? "abandoned" : available ? "accepted" : "unavailable"
      return {
        clientMessageId: row.clientMessageId,
        state,
        sessionId: row.sessionId,
        ...(state === "accepted" && receipt
          ? { receipt: { inputId: receipt.inputId, turnId: receipt.turnId, sequence: receipt.sequence } }
          : {}),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }
    })),
  }
}
