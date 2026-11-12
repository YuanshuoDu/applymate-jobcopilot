import { createHash } from "node:crypto"
import { withAgentSearchFootprintSessionSnapshot, type AgentSearchFootprintSessionSnapshot } from "@/lib/agent-search-footprint-session-snapshot"

export interface AgentSessionCreateIdempotencyInput {
  userId: string
  goal: string
  source: string
  status: string
  memorySummary: string
  idempotencyKey: string
  creationSnapshot?: AgentSearchFootprintSessionSnapshot
}

interface AgentSessionCreateDelegate {
  createMany(args: { data: Record<string, unknown>; skipDuplicates: true }): Promise<{ count: number }>
  findUnique(args: { where: Record<string, unknown> }): Promise<unknown>
}

export class AgentSessionIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was reused with a different session request")
  }
}

function hasCreateIdempotencyMethods(value: unknown): value is AgentSessionCreateDelegate {
  return typeof value === "object" && value !== null && "createMany" in value
    && typeof value.createMany === "function" && "findUnique" in value && typeof value.findUnique === "function"
}

export async function createIdempotentAgentSession(delegateValue: unknown, input: AgentSessionCreateIdempotencyInput) {
  if (!input.idempotencyKey || input.idempotencyKey.length > 128 || !/^[!-~]+$/.test(input.idempotencyKey)) {
    throw new TypeError("Session idempotency key must contain 1 to 128 visible ASCII characters")
  }
  if (!hasCreateIdempotencyMethods(delegateValue)) throw new Error("Session client does not support idempotent creation")

  const data = {
    userId: input.userId,
    goal: input.goal.trim(),
    source: input.source,
    status: input.status,
    memorySummary: input.memorySummary,
  }
  const requestHash = createHash("sha256").update(JSON.stringify(data)).digest("hex")
  const creationSnapshotFields = input.creationSnapshot ? {
    searchFootprintMemoryEnabledAtCreation: input.creationSnapshot.enabled,
    searchFootprintMemoryConsentVersionAtCreation: input.creationSnapshot.version,
  } : {}
  await delegateValue.createMany({
    data: { ...data, ...creationSnapshotFields, creationIdempotencyKey: input.idempotencyKey, creationIdempotencyRequestHash: requestHash },
    skipDuplicates: true,
  })
  const existing = await delegateValue.findUnique({
    where: { userId_creationIdempotencyKey: { userId: input.userId, creationIdempotencyKey: input.idempotencyKey } },
  })
  if (typeof existing !== "object" || existing === null || !("creationIdempotencyRequestHash" in existing)) {
    throw new Error("Idempotent session creation could not read its persisted Session")
  }
  if (existing.creationIdempotencyRequestHash !== requestHash) throw new AgentSessionIdempotencyConflictError()
  return existing
}

export async function reconcileIdempotentAgentSession(clientValue: unknown, userId: string, idempotencyKey: string) {
  if (!clientValue || typeof clientValue !== "object" || !("$transaction" in clientValue)
    || typeof clientValue.$transaction !== "function") {
    throw new Error("Session reconciliation requires an interactive transaction client")
  }
  return withAgentSearchFootprintSessionSnapshot(clientValue, userId, async (tx, _snapshot, captured) => {
    if (!captured) throw new Error("Session reconciliation could not acquire the consent snapshot lock")
    const session = await tx.agentSession.findUnique({
      where: { userId_creationIdempotencyKey: { userId, creationIdempotencyKey: idempotencyKey } },
      select: { id: true },
    })
    return session ? { state: "found" as const, sessionId: session.id } : { state: "unknown" as const }
  })
}
