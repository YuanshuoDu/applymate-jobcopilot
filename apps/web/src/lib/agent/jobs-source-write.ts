import type { Job, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { acquireSourceMaterialFence } from './source-material-fence'

export async function repairLinkedInDismissRoles(userId: string, jobs: Job[]): Promise<Job[]> {
  const candidates = jobs.filter(job => repairLinkedInDismissRole(job.role, job.source) !== null)
  if (candidates.length === 0) return jobs

  return db.$transaction(async tx => {
    await acquireSourceMaterialFence(tx, [userId])
    const repairedById = new Map<string, Job | null>()
    for (const candidate of candidates) {
      const where = { id: candidate.id, userId }
      const current = await tx.job.findFirst({ where })
      if (!current) {
        repairedById.set(candidate.id, null)
        continue
      }
      const repairedRole = repairLinkedInDismissRole(current.role, current.source)
      if (!repairedRole) {
        repairedById.set(candidate.id, current)
        continue
      }
      await tx.job.updateMany({
        where: { ...where, role: current.role, source: current.source },
        data: { role: repairedRole },
      })
      repairedById.set(candidate.id, await tx.job.findFirst({ where }))
    }
    return jobs.flatMap(job => {
      if (!repairedById.has(job.id)) return [job]
      const repaired = repairedById.get(job.id)
      return repaired ? [repaired] : []
    })
  })
}

export async function saveCanonicalJob(
  userId: string,
  url: string,
  createData: Prisma.JobUncheckedCreateInput,
  updateData: (existing: Job) => Prisma.JobUpdateManyMutationInput,
): Promise<{ job: Job; created: boolean }> {
  return db.$transaction(async tx => {
    await acquireSourceMaterialFence(tx, [userId])
    const existing = await tx.job.findFirst({ where: { userId, url } })
    if (!existing) return { job: await tx.job.create({ data: createData }), created: true }

    const result = await tx.job.updateMany({
      where: {
        id: existing.id, userId, url,
        company: existing.company, role: existing.role, description: existing.description,
        location: existing.location, salary: existing.salary, score: existing.score,
      },
      data: updateData(existing),
    })
    if (result.count !== 1) throw new Error('Existing job changed during save')
    const updated = await tx.job.findFirst({ where: { id: existing.id, userId } })
    if (!updated) throw new Error('Existing job disappeared during save')
    return { job: updated, created: false }
  })
}

function repairLinkedInDismissRole(role: string, source: string | null): string | null {
  if (source !== 'linkedin') return null
  const match = role.trim().match(/^dismiss\s+(.+?)\s+job$/i)
  return match?.[1]?.trim() || null
}
