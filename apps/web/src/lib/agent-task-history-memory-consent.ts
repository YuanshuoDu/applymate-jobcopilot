import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type AgentTaskHistoryMemoryConsent = {
  enabled: boolean
  version: number
}

export type AgentTaskHistoryMemoryConsentMutation = {
  enabled: boolean
  expectedVersion: number
}

export type AgentTaskHistoryMemoryConsentMutationResult =
  | { kind: 'updated'; consent: AgentTaskHistoryMemoryConsent }
  | { kind: 'stale'; consent: AgentTaskHistoryMemoryConsent }
  | { kind: 'not_found' }
  | { kind: 'version_exhausted'; consent: AgentTaskHistoryMemoryConsent }

type ConsentRow = {
  agentTaskHistoryMemoryEnabled: boolean
  agentTaskHistoryMemoryConsentVersion: number
}

function toConsent(row: ConsentRow): AgentTaskHistoryMemoryConsent {
  return {
    enabled: row.agentTaskHistoryMemoryEnabled,
    version: row.agentTaskHistoryMemoryConsentVersion,
  }
}

async function lockAgentTaskHistoryMemoryConsent(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('applymate:agent-task-history-memory:' || ${userId}::text, 0))::text AS lock_acquired`
}

export async function getAgentTaskHistoryMemoryConsent(
  userId: string,
  client: typeof db = db,
): Promise<AgentTaskHistoryMemoryConsent | null> {
  const row = await client.user.findUnique({
    where: { id: userId },
    select: { agentTaskHistoryMemoryEnabled: true, agentTaskHistoryMemoryConsentVersion: true },
  })
  return row ? toConsent(row) : null
}

export async function setAgentTaskHistoryMemoryConsent(
  userId: string,
  input: AgentTaskHistoryMemoryConsentMutation,
  client: typeof db = db,
): Promise<AgentTaskHistoryMemoryConsentMutationResult> {
  return client.$transaction(async tx => {
    await lockAgentTaskHistoryMemoryConsent(tx, userId)
    const row = await tx.user.findUnique({
      where: { id: userId },
      select: { agentTaskHistoryMemoryEnabled: true, agentTaskHistoryMemoryConsentVersion: true },
    })
    if (!row) return { kind: 'not_found' }

    const consent = toConsent(row)
    if (consent.version !== input.expectedVersion) return { kind: 'stale', consent }
    if (consent.version === 2_147_483_647) return { kind: 'version_exhausted', consent }

    const update = await tx.user.updateMany({
      where: { id: userId, agentTaskHistoryMemoryConsentVersion: input.expectedVersion },
      data: {
        agentTaskHistoryMemoryEnabled: input.enabled,
        agentTaskHistoryMemoryConsentVersion: { increment: 1 },
      },
    })
    if (update.count !== 1) {
      const latest = await tx.user.findUnique({
        where: { id: userId },
        select: { agentTaskHistoryMemoryEnabled: true, agentTaskHistoryMemoryConsentVersion: true },
      })
      return latest ? { kind: 'stale', consent: toConsent(latest) } : { kind: 'not_found' }
    }

    return { kind: 'updated', consent: { enabled: input.enabled, version: consent.version + 1 } }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
}
