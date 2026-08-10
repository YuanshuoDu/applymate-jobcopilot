import { db } from './db'
import { retainsGeneratedCoverLetters } from './privacy-consent'

/** Remove non-final AI artifacts after an application when retention is off. */
export async function purgeTemporaryGeneratedCoverLetters(userId: string, jobId: string): Promise<number> {
  const [user, job] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { preferences: true } }),
    db.job.findFirst({ where: { id: jobId, userId }, select: { finalCoverLetterId: true } }),
  ])
  if (!user || !job || retainsGeneratedCoverLetters(user.preferences)) return 0

  const result = await db.coverLetter.deleteMany({
    where: {
      userId,
      jobId,
      origin: { in: ['agent', 'ai-generated'] },
      isFinal: false,
      ...(job.finalCoverLetterId ? { id: { not: job.finalCoverLetterId } } : {}),
    },
  })
  return result.count
}
