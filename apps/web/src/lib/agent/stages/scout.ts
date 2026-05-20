/**
 * Stage 1 — Scout
 * Role: 侦察员
 *
 * TWO-PHASE operation:
 *
 *   Phase A — Discovery (NEW):
 *     Uses job APIs to autonomously discover new openings matching the user's
 *     targetRoles × targetLocations. Newly found jobs are saved to the DB
 *     (status = 'saved') so the pipeline processes them immediately.
 *     Skips if targetRoles is empty (user has not configured their profile).
 *
 *   Phase B — Load saved (existing):
 *     Loads all status='saved' jobs (including newly discovered ones), applies
 *     exclusion / priority / dedup filters, and truncates to dailyLimit.
 *
 * Filters applied (in order):
 *  1. Exclude companies in agentCfg.excludeCompanies (case-insensitive)
 *  2. Priority companies bypass the dedup check
 *  3. Skip already-scored-today (dedup)
 *  4. Truncate to dailyLimit
 */
import { db }          from '@/lib/db'
import { discoverJobs } from '@/lib/agent/discover'
import type { PipelineCtx, ScoutOutput, StageResult, AcceptResult } from '../types'
import { stageOk, stageFail } from '../types'

export async function runScout(ctx: PipelineCtx): Promise<StageResult<ScoutOutput>> {
  const t0 = Date.now()
  const { agentCfg, userId, emit } = ctx

  try {
    // ── Phase A: Autonomous discovery ─────────────────────────────────────────
    let discovered = 0

    if (agentCfg.targetRoles.length > 0) {
      // Collect existing job URLs to avoid duplicates
      const existingJobs = await db.job.findMany({
        where: { userId },
        select: { url: true },
      })
      const existingUrls = new Set(
        existingJobs.map(j => j.url).filter((u): u is string => !!u)
      )

      const candidates = await discoverJobs({
        targetRoles:     agentCfg.targetRoles,
        targetLocations: agentCfg.targetLocations,
        existingUrls,
        maxResults:      agentCfg.dailyLimit * 2,  // over-fetch; pipeline will trim
      })

      if (candidates.length > 0) {
        // Batch-insert newly discovered jobs
        const rows = candidates.map(j => ({
          userId,
          company:     j.company,
          role:        j.title,
          location:    j.location    || null,
          url:         j.url         || null,
          description: j.description || null,
          salary:      j.salary      || null,
          logo:        j.logo        || j.company.slice(0, 2).toUpperCase(),
          source:      j.source      || 'agent',
          status:      'saved' as const,
        }))

        await db.job.createMany({ data: rows, skipDuplicates: true })
        discovered = rows.length

        // Log the discovery as a batch activity
        await db.activity.create({
          data: {
            userId,
            type:  'agent_action',
            text:  `Agent discovered ${discovered} new job${discovered === 1 ? '' : 's'} (${agentCfg.targetRoles.slice(0, 2).join(', ')})`,
            color: '#185FA5',
          },
        })
      }
    }

    // ── Phase B: Load saved jobs (includes newly discovered) ──────────────────
    const allSaved = await db.job.findMany({
      where:   { userId, status: 'saved' },
      orderBy: [
        { score: 'asc' },      // unscored first (null sorts first in Prisma)
        { createdAt: 'desc' }, // then newest
      ],
    })

    const excludeSet  = new Set(agentCfg.excludeCompanies.map(c => c.toLowerCase().trim()))
    const prioritySet = new Set(agentCfg.priorityCompanies.map(c => c.toLowerCase().trim()))

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)

    // Build location filter set (normalised to lowercase keywords)
    const locationSet = agentCfg.targetLocations.length > 0
      ? new Set(agentCfg.targetLocations.map(l => l.toLowerCase().trim()))
      : null   // null = no location filter

    const candidates = allSaved.filter(job => {
      const nameLower = job.company.toLowerCase().trim()

      if (excludeSet.has(nameLower)) return false
      if (prioritySet.has(nameLower)) return true   // priority always passes

      // Location filter (soft match: job.location contains any target location keyword)
      if (locationSet) {
        const jobLoc = (job.location ?? '').toLowerCase()
        // Allow if location is unset (no location data on job) OR location matches any target
        const locationMatch = !job.location ||
          [...locationSet].some(loc => jobLoc.includes(loc) || loc.includes(jobLoc.split(',')[0]?.trim() ?? ''))
        if (!locationMatch) {
          // Emit skip for visibility
          ctx.emit('job_skip', { jobId: job.id, company: job.company, role: job.role, reason: `地点不匹配 (${job.location} ≠ ${agentCfg.targetLocations.join('/')})` })
          return false
        }
      }

      if (job.score !== null && job.updatedAt >= todayStart) return false  // already scored today

      return true
    })

    // Emit observation about location filtering
    if (locationSet && allSaved.length > candidates.length) {
      const filtered = allSaved.length - candidates.length
      ctx.emit('agent_observation', {
        role: 'scout',
        observation: `📍 地点过滤：${allSaved.length} 个已保存职位中，${filtered} 个不匹配 [${agentCfg.targetLocations.join(', ')}]，已排除`,
      })
    }

    const jobs = candidates.slice(0, agentCfg.dailyLimit)

    return stageOk(
      'scout',
      { jobs, discovered },
      jobs.length,
      Date.now() - t0,
    )
  } catch (error) {
    return stageFail('scout', `Scout failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function acceptScout(result: StageResult<ScoutOutput>): AcceptResult {
  if (!result.ok || !result.data) {
    return { ok: false, reason: result.error ?? 'Scout returned no data' }
  }
  if (!Array.isArray(result.data.jobs)) {
    return { ok: false, reason: 'Scout: jobs is not an array' }
  }
  return { ok: true }
}
