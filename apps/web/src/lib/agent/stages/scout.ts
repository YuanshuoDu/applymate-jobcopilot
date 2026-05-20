/**
 * Stage 1 — Scout (侦察员)
 *
 * THREE-PHASE operation:
 *
 *   Phase A — Live Search (NEW JOBS):
 *     Calls job APIs with targetRoles × targetLocations as SEARCH PARAMETERS
 *     (location filter is applied AT SEARCH TIME, not post-fetch).
 *     Saves discovered jobs to DB (status='saved') for the pipeline.
 *     If location-specific search returns 0 results, retries without location.
 *
 *   Phase B — Load Saved Jobs (DB-LEVEL filter):
 *     Prisma WHERE clause filters by location at DB level — NOT post-JS-filter.
 *     Priority companies bypass location filter.
 *     Dedup: skips jobs already scored today.
 *
 *   Phase C — Format & Emit:
 *     Emits a structured list of queued jobs for the UI and Orchestrator.
 *
 * Key principle: location filter is applied BEFORE loading data, not after.
 */
import { db }          from '@/lib/db'
import { discoverJobs } from '@/lib/agent/discover'
import type { PipelineCtx, ScoutOutput, StageResult, AcceptResult } from '../types'
import { stageOk, stageFail } from '../types'

export async function runScout(ctx: PipelineCtx): Promise<StageResult<ScoutOutput>> {
  const t0 = Date.now()
  const { agentCfg, userId, emit } = ctx

  const hasTargetRoles = agentCfg.targetRoles.length > 0
  const hasLocations   = agentCfg.targetLocations.length > 0

  try {
    // ── Phase A: Live search with location applied at API level ───────────────
    let discovered = 0

    if (hasTargetRoles) {
      emit('agent_action', {
        role:   'scout',
        action: hasLocations
          ? `在 [${agentCfg.targetLocations.join(', ')}] 搜索 [${agentCfg.targetRoles.slice(0, 3).join(', ')}]…`
          : `全球搜索 [${agentCfg.targetRoles.slice(0, 3).join(', ')}]…`,
      })

      const existingUrls = new Set(
        (await db.job.findMany({ where: { userId }, select: { url: true } }))
          .map(j => j.url).filter((u): u is string => !!u)
      )

      // First attempt: search with location
      let candidates = await discoverJobs({
        targetRoles:     agentCfg.targetRoles,
        targetLocations: agentCfg.targetLocations,
        existingUrls,
        maxResults:      agentCfg.dailyLimit * 2,
      })

      emit('agent_observation', {
        role:        'scout',
        observation: `🔍 API 搜索返回 ${candidates.length} 个结果${hasLocations ? ` (${agentCfg.targetLocations.join(', ')})` : ''}`,
      })

      // If location-filtered search returns 0, retry without location restriction
      if (candidates.length === 0 && hasLocations) {
        emit('agent_observation', {
          role:        'scout',
          observation: `⚠ 在指定地点未找到职位，尝试扩大搜索范围（不限地点）…`,
        })
        candidates = await discoverJobs({
          targetRoles:     agentCfg.targetRoles,
          targetLocations: [],   // no location filter
          existingUrls,
          maxResults:      agentCfg.dailyLimit * 2,
        })
        emit('agent_observation', {
          role:        'scout',
          observation: `🔍 不限地点搜索返回 ${candidates.length} 个结果`,
        })
      }

      if (candidates.length > 0) {
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

        // Format discovered jobs as a list
        const listText = candidates.slice(0, 8).map(j =>
          `- **${j.company}** · ${j.title}${j.location ? ` · 📍${j.location}` : ''}${j.salary ? ` · ${j.salary}` : ''}`
        ).join('\n') + (candidates.length > 8 ? `\n- …及 ${candidates.length - 8} 个更多` : '')

        emit('agent_observation', {
          role:        'scout',
          observation: `✓ 发现并保存了 ${discovered} 个新职位：\n${listText}`,
        })

        await db.activity.create({
          data: {
            userId,
            type:  'agent_action',
            text:  `Agent 搜索发现 ${discovered} 个新职位 (${agentCfg.targetRoles.slice(0, 2).join(', ')})`,
            color: '#185FA5',
          },
        })
      }
    }

    // ── Phase B: Load saved jobs with DB-level location filter ────────────────
    // Location filter is applied in Prisma WHERE — not in JS after loading all rows.

    const excludeSet  = new Set(agentCfg.excludeCompanies.map(c => c.toLowerCase().trim()))
    const prioritySet = new Set(agentCfg.priorityCompanies.map(c => c.toLowerCase().trim()))

    // Build Prisma OR conditions for location matching
    const locationWhere = hasLocations
      ? {
          OR: [
            { location: null },   // include jobs with no location metadata
            { location: '' },
            // Match any of the target locations (case-insensitive contains)
            ...agentCfg.targetLocations.map(loc => ({
              location: { contains: loc, mode: 'insensitive' as const },
            })),
            // Also match priority companies regardless of location
            ...(agentCfg.priorityCompanies.length > 0 ? [{
              company: { in: agentCfg.priorityCompanies },
            }] : []),
          ],
        }
      : {}   // no location filter

    const allSaved = await db.job.findMany({
      where: {
        userId,
        status: 'saved',
        // Exclude blacklisted companies at DB level
        NOT: excludeSet.size > 0
          ? { company: { in: [...excludeSet] } }
          : undefined,
        // Location filter at DB level
        ...locationWhere,
      },
      orderBy: [
        { score: 'asc' },       // unscored first
        { createdAt: 'desc' },  // then newest
      ],
    })

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)

    const candidates = allSaved.filter(job => {
      // Priority companies always pass
      if (prioritySet.has(job.company.toLowerCase().trim())) return true
      // Skip already scored today (dedup)
      if (job.score !== null && job.updatedAt >= todayStart) return false
      return true
    })

    const jobs = candidates.slice(0, agentCfg.dailyLimit)

    // Emit formatted job list
    if (jobs.length > 0) {
      const jobList = jobs.slice(0, 10).map(j =>
        `- **${j.company}** · ${j.role}${j.location ? ` · 📍${j.location}` : ''}${j.score != null ? ` · ${j.score}%` : ' · 未评分'}`
      ).join('\n') + (jobs.length > 10 ? `\n- …及 ${jobs.length - 10} 个更多` : '')

      emit('agent_observation', {
        role:        'scout',
        observation: `📋 进入分析队列（共 ${jobs.length} 个）：\n${jobList}`,
      })
    } else if (hasLocations) {
      // Zero results — emit a question via orchestrator
      const savedTotal = await db.job.count({ where: { userId, status: 'saved' } })
      if (savedTotal > 0) {
        emit('agent_question', {
          role:       'scout',
          questionId: 'no_local_jobs',
          question:   `已保存的 ${savedTotal} 个职位中没有符合 [${agentCfg.targetLocations.join(', ')}] 的职位，且 API 搜索也未找到新职位。\n\n建议：`,
          options: [
            { label: `🌍 移除地点限制，分析全部 ${savedTotal} 个职位`, value: 'remove_location', action: { field: 'targetLocations', value: [] } },
            { label: '✏ 去 Search Jobs 页面手动搜索',                   value: 'goto_search',   action: { field: '_navigate', value: 'search' } },
            { label: '✕ 中止本次运行',                                   value: 'abort' },
          ],
        })
      }
    }

    return stageOk('scout', { jobs, discovered }, jobs.length, Date.now() - t0)

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
