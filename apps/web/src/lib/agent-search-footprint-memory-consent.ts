import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

const MAX_CONSENT_VERSION = 2_147_483_647

export type AgentSearchFootprintMemoryConsent = { enabled: boolean; version: number }
export type AgentSearchFootprintMemoryConsentMutation = { enabled: boolean; expectedVersion: number }
export type AgentSearchFootprintMemoryConsentMutationResult =
  | { kind: 'updated'; consent: AgentSearchFootprintMemoryConsent }
  | { kind: 'unchanged'; consent: AgentSearchFootprintMemoryConsent }
  | { kind: 'stale'; consent: AgentSearchFootprintMemoryConsent }
  | { kind: 'not_found' }
  | { kind: 'version_exhausted'; consent: AgentSearchFootprintMemoryConsent }

type ConsentRow = {
  agentSearchFootprintMemoryEnabled: boolean
  agentSearchFootprintMemoryConsentVersion: number
}

function toConsent(row: ConsentRow): AgentSearchFootprintMemoryConsent {
  return { enabled: row.agentSearchFootprintMemoryEnabled, version: row.agentSearchFootprintMemoryConsentVersion }
}

export async function lockAgentSearchFootprintMemoryConsent(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('applymate:agent-search-footprint-memory:' || ${userId}::text, 0))::text AS lock_acquired`
}

export async function getAgentSearchFootprintMemoryConsent(
  userId: string,
  client: typeof db = db,
): Promise<AgentSearchFootprintMemoryConsent | null> {
  const row = await client.user.findUnique({
    where: { id: userId },
    select: { agentSearchFootprintMemoryEnabled: true, agentSearchFootprintMemoryConsentVersion: true },
  })
  return row ? toConsent(row) : null
}

export async function setAgentSearchFootprintMemoryConsent(
  userId: string,
  input: AgentSearchFootprintMemoryConsentMutation,
  client: typeof db = db,
): Promise<AgentSearchFootprintMemoryConsentMutationResult> {
  return client.$transaction(async tx => {
    await lockAgentSearchFootprintMemoryConsent(tx, userId)
    const row = await tx.user.findUnique({
      where: { id: userId },
      select: { agentSearchFootprintMemoryEnabled: true, agentSearchFootprintMemoryConsentVersion: true },
    })
    if (!row) return { kind: 'not_found' }

    const consent = toConsent(row)
    if (consent.version !== input.expectedVersion) return { kind: 'stale', consent }
    if (consent.enabled === input.enabled) return { kind: 'unchanged', consent }
    const terminalRevocation = consent.version === MAX_CONSENT_VERSION
    if (terminalRevocation && input.enabled) return { kind: 'version_exhausted', consent }

    const update = await tx.user.updateMany({
      where: { id: userId, agentSearchFootprintMemoryConsentVersion: input.expectedVersion },
      data: {
        agentSearchFootprintMemoryEnabled: input.enabled,
        ...(terminalRevocation ? {} : { agentSearchFootprintMemoryConsentVersion: { increment: 1 } }),
      },
    })
    if (update.count !== 1) {
      const latest = await tx.user.findUnique({
        where: { id: userId },
        select: { agentSearchFootprintMemoryEnabled: true, agentSearchFootprintMemoryConsentVersion: true },
      })
      return latest ? { kind: 'stale', consent: toConsent(latest) } : { kind: 'not_found' }
    }
    return { kind: 'updated', consent: { enabled: input.enabled, version: terminalRevocation ? consent.version : consent.version + 1 } }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
}
