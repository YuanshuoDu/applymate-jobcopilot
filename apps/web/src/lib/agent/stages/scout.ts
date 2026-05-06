/**
 * Stage 1 — Scout
 * Role: 侦察员
 * Loads saved jobs, applies all filters, and returns the candidate list.
 *
 * Filters applied (in order):
 *  1. Only status='saved' (never re-process applied/review/etc.)
 *  2. Exclude companies in agentCfg.excludeCompanies (case-insensitive)
 *  3. Deduplicate: skip jobs already scored today (score != null AND updatedAt today)
 *  4. Priority boost: companies in priorityCompanies skip the dedup check
 *  5. Truncate to dailyLimit
 */
import { db } from '@/lib/db'
import type { PipelineCtx, ScoutOutput, StageResult, AcceptResult } from '../types'
import { stageOk, stageFail } from '../types'

export async function runScout(ctx: PipelineCtx): Promise<StageResult<ScoutOutput>> {
  const t0 = Date.now()
  const { agentCfg, userId } = ctx

  try {
    // Load all saved jobs (we'll filter in JS for flexibility)
    const allSaved = await db.job.findMany({
      where:   { userId, status: 'saved' },
      orderBy: [
        { score: 'asc' },      // unscored first
        { createdAt: 'desc' }, // then newest
      ],
    })

    const excludeSet = new Set(
      agentCfg.excludeCompanies.map(c => c.toLowerCase().trim())
    )
    const prioritySet = new Set(
      agentCfg.priorityCompanies.map(c => c.toLowerCase().trim())
    )

    // Start of today (UTC) for dedup check
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)

    const candidates = allSaved.filter(job => {
      const nameLower = job.company.toLowerCase().trim()

      // Rule 1: exclude companies list
      if (excludeSet.has(nameLower)) return false

      // Rule 2: priority companies always pass (even if already scored today)
      if (prioritySet.has(nameLower)) return true

      // Rule 3: skip already-scored-today (dedup)
      if (
        job.score !== null &&
        job.updatedAt >= todayStart
      ) return false

      return true
    })

    // Apply daily limit
    const jobs = candidates.slice(0, agentCfg.dailyLimit)

    return stageOk('scout', { jobs }, jobs.length, Date.now() - t0)
  } catch (err) {
    return stageFail('scout', `Scout failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function acceptScout(result: StageResult<ScoutOutput>): AcceptResult {
  if (!result.ok || !result.data) {
    return { ok: false, reason: result.error ?? 'Scout returned no data' }
  }
  // Accept: jobs array present (empty is valid — will short-circuit pipeline)
  if (!Array.isArray(result.data.jobs)) {
    return { ok: false, reason: 'Scout: jobs is not an array' }
  }
  return { ok: true }
}
