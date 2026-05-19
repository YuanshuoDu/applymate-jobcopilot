/**
 * One-off migration: Job.coverLetter (string) → CoverLetter table
 * Run once in production: npx ts-node apps/web/scripts/migrate-cover-letter-string-to-table.ts
 */
import { PrismaClient } from '@prisma/client'

const BATCH_SIZE = 200

async function main() {
  const db = new PrismaClient()
  let cursor: string | undefined
  let totalMigrated = 0
  let totalSkipped = 0

  try {
    while (true) {
      const jobs = await db.job.findMany({
        where: { coverLetter: { not: null } },
        select: { id: true, userId: true, coverLetter: true, finalCoverLetterId: true },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      })

      if (jobs.length === 0) break
      cursor = jobs[jobs.length - 1].id

      for (const job of jobs) {
        if (!job.coverLetter) continue

        // Already has a CL row — check if finalCoverLetterId is also set
        const existing = await db.coverLetter.findFirst({ where: { jobId: job.id } })
        if (existing) {
          if (!job.finalCoverLetterId) {
            // Partial migration: CL exists but job pointer was never set — fix it
            await db.job.update({ where: { id: job.id }, data: { finalCoverLetterId: existing.id } })
            console.log(`  Repaired pointer for job ${job.id} → CoverLetter ${existing.id}`)
            totalMigrated++
          } else {
            console.log(`  Skipping ${job.id} — already fully migrated`)
            totalSkipped++
          }
          continue
        }

        // Atomic: create CL + set finalCoverLetterId together
        await db.$transaction(async (tx) => {
          const cl = await tx.coverLetter.create({
            data: {
              userId:  job.userId,
              jobId:   job.id,
              content: job.coverLetter!,
              tone:    'professional',
              origin:  'manual',
              isFinal: true,
            },
          })
          await tx.job.update({
            where: { id: job.id },
            data:  { finalCoverLetterId: cl.id },
          })
          console.log(`  Migrated job ${job.id} → CoverLetter ${cl.id}`)
        })

        totalMigrated++
      }
    }
  } finally {
    await db.$disconnect()
  }

  console.log(`Migration complete — migrated: ${totalMigrated}, skipped: ${totalSkipped}`)
}

main().catch(console.error)
