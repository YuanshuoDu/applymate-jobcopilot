import type { Prisma } from '@prisma/client'

export type AgentSearchFootprintSessionSnapshot = Readonly<{ enabled: boolean; version: number }>
type ConsentRow = {
  agentSearchFootprintMemoryEnabled: boolean
  agentSearchFootprintMemoryConsentVersion: number
}
type SnapshotTransaction = Pick<Prisma.TransactionClient, '$queryRaw' | 'user' | 'agentSession'>
type SnapshotClient = SnapshotTransaction & {
  $transaction?: <T>(work: (tx: SnapshotTransaction) => Promise<T>) => Promise<T>
}
function canCaptureConsent(value: unknown): value is SnapshotTransaction {
  if (!value || typeof value !== 'object') return false
  const row = value as { $queryRaw?: unknown; user?: { findUnique?: unknown } }
  return typeof row.$queryRaw === 'function' && typeof row.user?.findUnique === 'function'
}

async function capture(tx: SnapshotTransaction, userId: string): Promise<AgentSearchFootprintSessionSnapshot> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('applymate:agent-search-footprint-memory:' || ${userId}::text, 0))::text AS lock_acquired`
  const row = await tx.user.findUnique({
    where: { id: userId },
    select: { agentSearchFootprintMemoryEnabled: true, agentSearchFootprintMemoryConsentVersion: true },
  }) as ConsentRow | null
  if (!row || typeof row.agentSearchFootprintMemoryEnabled !== 'boolean'
    || !Number.isSafeInteger(row.agentSearchFootprintMemoryConsentVersion)
    || row.agentSearchFootprintMemoryConsentVersion < 0) {
    throw new Error('Agent search footprint memory consent could not be verified')
  }
  return { enabled: row.agentSearchFootprintMemoryEnabled, version: row.agentSearchFootprintMemoryConsentVersion }
}

/** Creates with consent under the same transaction lock used by consent mutations. */
export async function withAgentSearchFootprintSessionSnapshot<T>(
  clientValue: unknown,
  userId: string,
  work: (tx: SnapshotTransaction, snapshot: AgentSearchFootprintSessionSnapshot, captured: boolean) => Promise<T>,
): Promise<T> {
  if (!clientValue || typeof clientValue !== 'object') throw new Error('Agent session persistence is unavailable')
  const client = clientValue as SnapshotClient
  if (typeof client.$transaction === 'function') {
    return client.$transaction(async tx => canCaptureConsent(tx)
      ? work(tx, await capture(tx, userId), true)
      : work(tx, { enabled: false, version: 0 }, false))
  }
  if (canCaptureConsent(client)) return work(client, await capture(client, userId), true)

  // Minimal in-memory test doubles cannot read consent; database defaults remain disabled/version 0.
  return work(client, { enabled: false, version: 0 }, false)
}

export function sessionSnapshotFields(snapshot: AgentSearchFootprintSessionSnapshot) {
  return {
    searchFootprintMemoryEnabledAtCreation: snapshot.enabled,
    searchFootprintMemoryConsentVersionAtCreation: snapshot.version,
  }
}
