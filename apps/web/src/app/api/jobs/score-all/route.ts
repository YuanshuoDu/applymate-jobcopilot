import { NextRequest } from 'next/server'
import { pinnedFetch } from '@jobcopilot/shared'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'
import type { ResumeContent } from '@/lib/types'

const MAX_JOBS_PER_RUN = 50
const SCORE_CONCURRENCY = 2

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const resume = await db.resume.findFirst({
    where: { userId: auth.userId },
    orderBy: { isDefault: 'desc' },
    select: { content: true },
  })
  if (!resume) return err('Set a default resume before scoring jobs', 400)

  const jobs = await db.job.findMany({
    where: { userId: auth.userId, score: null },
    orderBy: { createdAt: 'desc' },
    take: MAX_JOBS_PER_RUN,
    select: { id: true, role: true, company: true, description: true, keywords: true },
  })
  if (!jobs.length) return ok({ scored: 0, failed: 0, remaining: 0 })

  const cookie = req.headers.get('cookie') ?? ''
  const scoreUrl = new URL('/api/ai/score', req.url)
  const results = await runWithConcurrency(jobs, SCORE_CONCURRENCY, async job => {
    const scoreResponse = await pinnedFetch(scoreUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      allowLocalDevelopment: process.env.NODE_ENV !== 'production',
      body: JSON.stringify({
        resumeContent: resume.content as unknown as ResumeContent,
        jobTitle: job.role,
        jobCompany: job.company,
        jobDescription: job.description,
        keySkills: job.keywords?.split(',').map(skill => skill.trim()).filter(Boolean),
      }),
    })
    if (!scoreResponse.ok) throw new Error('AI scoring request failed')

    const result = await scoreResponse.json() as { score?: number; keywords?: string }
    return db.$transaction(async tx => {
      await acquireSourceMaterialFence(tx, [auth.userId])

      const currentJob = await tx.job.findFirst({
        where: { id: job.id, userId: auth.userId },
        select: {
          userId: true,
          role: true,
          company: true,
          description: true,
          keywords: true,
          score: true,
        },
      })
      if (
        !currentJob ||
        currentJob.userId !== auth.userId ||
        currentJob.role !== job.role ||
        currentJob.company !== job.company ||
        currentJob.description !== job.description ||
        currentJob.keywords !== job.keywords ||
        currentJob.score !== null
      ) return false

      const currentResume = await tx.resume.findFirst({
        where: { userId: auth.userId },
        orderBy: { isDefault: 'desc' },
        select: { content: true },
      })
      if (!currentResume || JSON.stringify(currentResume.content) !== JSON.stringify(resume.content)) return false

      const update = await tx.job.updateMany({
        where: {
          id: job.id,
          userId: auth.userId,
          role: job.role,
          company: job.company,
          description: job.description,
          keywords: job.keywords,
          score: null,
        },
        data: { score: Number(result.score) || 0, keywords: result.keywords ?? '' },
      })
      return update.count === 1
    })
  })

  const scored = results.filter(result => result.ok).length
  const failed = results.length - scored
  const remaining = await db.job.count({ where: { userId: auth.userId, score: null } })
  return ok({ scored, failed, remaining })
}

async function runWithConcurrency<T>(items: T[], concurrency: number, work: (item: T) => Promise<boolean>) {
  const results: Array<{ ok: boolean }> = []
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex++]
      try {
        results.push({ ok: await work(item) })
      } catch {
        results.push({ ok: false })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}
