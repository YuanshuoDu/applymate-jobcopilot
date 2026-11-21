import type { Job, Prisma } from '@prisma/client'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'

export type EnrichmentJobSnapshot = Pick<
  Job,
  'id' | 'userId' | 'url' | 'company' | 'role' | 'location' | 'description' | 'salary' | 'logo' | 'analysisNote'
>

export type EnrichmentSourceWrites = Partial<Pick<Job, 'description' | 'salary' | 'logo' | 'analysisNote'>>

const SOURCE_FIELDS = ['description', 'salary', 'logo'] as const

/** Persists only enrichment derived from the unchanged, authenticated Job snapshot. */
export async function writeEnrichmentSourceMaterial(
  tx: Prisma.TransactionClient,
  snapshot: EnrichmentJobSnapshot,
  writes: EnrichmentSourceWrites,
): Promise<Job | null> {
  await acquireSourceMaterialFence(tx, [snapshot.userId])

  const sourceWhere: Prisma.JobWhereInput = {
    id: snapshot.id,
    userId: snapshot.userId,
    url: snapshot.url,
    company: snapshot.company,
    role: snapshot.role,
    location: snapshot.location,
  }

  for (const field of SOURCE_FIELDS) {
    const value = writes[field]
    const oldValue = snapshot[field]
    if (typeof value !== 'string' || value.length === 0 || oldValue) continue

    const where: Prisma.JobWhereInput = { ...sourceWhere, [field]: oldValue }
    const data: Prisma.JobUpdateManyMutationInput = { [field]: value }
    await tx.job.updateMany({ where, data })
  }

  // analysisNote is also used for Analyst recommendations; never replace a non-empty note.
  const note = writes.analysisNote
  if (typeof note === 'string' && note.length > 0 && !snapshot.analysisNote) {
    const where: Prisma.JobWhereInput = { ...sourceWhere, analysisNote: snapshot.analysisNote }
    await tx.job.updateMany({ where, data: { analysisNote: note } })
  }

  return tx.job.findFirst({ where: { id: snapshot.id, userId: snapshot.userId } })
}
