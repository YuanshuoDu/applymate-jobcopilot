/** Scout searches for new jobs, persists them, then loads the user's saved queue. */
import type { Prisma } from '@prisma/client'
import { db }          from '@/lib/db'
import { discoverJobs } from '@/lib/agent/discover'
import { resolveLocations, buildLocationWhere, locationSummary } from '@/lib/agent/location-resolver'
import type { PipelineCtx, ScoutOutput, StageResult, AcceptResult } from '../types'
import { stageOk, stageFail } from '../types'
import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from '../execution-control'

function assertSignalActive(ctx: PipelineCtx): void {
  if (ctx.signal?.aborted) throw new AgentExecutionCancelledError()
}

class OwnershipCheckUnavailableError extends Error {
  constructor(cause: unknown) { super(`Scout ownership check failed: ${cause instanceof Error ? cause.message : String(cause)}`); this.name = 'OwnershipCheckUnavailableError' }
}

async function ownedWrite<T>(ctx: PipelineCtx, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    assertSignalActive(ctx)
    if (ctx.executionAttempt) {
      let current: boolean
      try { current = await refreshAgentExecutionAttempt(tx, { ...ctx.executionAttempt, userId: ctx.userId }) }
      catch (error: unknown) { throw new OwnershipCheckUnavailableError(error) }
      if (!current) throw new AgentExecutionCancelledError()
      assertSignalActive(ctx)
    }
    const result = await write(tx)
    assertSignalActive(ctx)
    return result
  })
}

export async function runScout(ctx: PipelineCtx): Promise<StageResult<ScoutOutput>> {
  const t0 = Date.now()
  const { agentCfg, userId, emit } = ctx

  const hasTargetRoles = agentCfg.targetRoles.length > 0
  const hasLocations   = agentCfg.targetLocations.length > 0

  // Resolve locations ONCE — expand "Ireland" → Dublin/Cork/Galway/etc.
  const locResolved = resolveLocations(agentCfg.targetLocations)
  const locSummary  = locationSummary(agentCfg.targetLocations)

  try {
    assertSignalActive(ctx)
    // ── Phase A: Live search — location filter applied at API search level ────
    let discovered = 0

    if (hasTargetRoles) {
      emit('agent_action', {
        role:   'scout',
        action: hasLocations
          ? `search [${agentCfg.targetRoles.slice(0, 3).join(', ')}], Place: ${locSummary}`
          : `Global search [${agentCfg.targetRoles.slice(0, 3).join(', ')}]`,
      })

      const existingUrls = new Set(
        (await db.job.findMany({ where: { userId }, select: { url: true } }))
          .map(j => j.url).filter((u): u is string => !!u)
      )
      assertSignalActive(ctx)

      // First attempt: search with location
      let candidates = await discoverJobs({
        userId,
        targetRoles:     agentCfg.targetRoles,
        targetLocations: agentCfg.targetLocations,
        existingUrls,
        maxResults:      agentCfg.dailyLimit * 2,
      })
      assertSignalActive(ctx)

      emit('agent_observation', {
        role:        'scout',
        observation: `🔍 API Search returns ${candidates.length} results${hasLocations ? ` (${agentCfg.targetLocations.join(', ')})` : ''}`,
      })

      // If location-filtered search returns 0, retry without location restriction
      if (candidates.length === 0 && hasLocations) {
        emit('agent_observation', {
          role:        'scout',
          observation: `⚠ No jobs found in the specified location, Try broadening your search(Any location)…`,
        })
        candidates = await discoverJobs({
          userId,
          targetRoles:     agentCfg.targetRoles,
          targetLocations: [],   // no location filter
          existingUrls,
          maxResults:      agentCfg.dailyLimit * 2,
        })
        assertSignalActive(ctx)
        emit('agent_observation', {
          role:        'scout',
          observation: `🔍 Search returns regardless of location ${candidates.length} results`,
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
        // Persist independently so malformed API records do not abort discovery.
        const writes = await Promise.allSettled(rows.map(data => ownedWrite(ctx, tx => tx.job.create({ data }))))
        const ownershipLost = writes.find(write => write.status === 'rejected' && write.reason instanceof AgentExecutionCancelledError)
        if (ownershipLost?.status === 'rejected') throw ownershipLost.reason
        const ownershipCheckFailed = writes.find(write => write.status === 'rejected' && write.reason instanceof OwnershipCheckUnavailableError)
        if (ownershipCheckFailed?.status === 'rejected') throw ownershipCheckFailed.reason
        discovered = writes.filter(write => write.status === 'fulfilled').length
        const failedWrites = writes.length - discovered

        if (discovered === 0) {
          const firstFailure = writes.find(
            (write): write is PromiseRejectedResult => write.status === 'rejected',
          )
          throw firstFailure?.reason ?? new Error('No discovered jobs could be saved')
        }

        const listText = candidates.slice(0, 8).map(j =>
          `- **${j.company}** · ${j.title}${j.location ? ` · 📍${j.location}` : ''}${j.salary ? ` · ${j.salary}` : ''}`
        ).join('\n') + (candidates.length > 8 ? `\n- …and ${candidates.length - 8} more` : '')

        emit('agent_observation', {
          role:        'scout',
          observation: `✓ Found and saved ${discovered} new positions${failedWrites > 0 ? `(${failedWrites} Invalid records have been skipped)` : ''}: \n${listText}`,
        })

        await ownedWrite(ctx, tx => tx.activity.create({
          data: { userId, type: 'agent_action', text: `Agent Search found ${discovered} new positions (${agentCfg.targetRoles.slice(0, 2).join(', ')})`, color: '#185FA5' },
        }))
      }
    }

    // ── Phase B: Load saved jobs with DB-level location filter ────────────────
    // Uses resolved location terms — "Ireland" expands to Dublin/Cork/Galway/etc.
    // Filter is applied at Prisma WHERE level, not post-JS-filter.

    const excludeSet  = new Set(agentCfg.excludeCompanies.map(c => c.toLowerCase().trim()))
    const prioritySet = new Set(agentCfg.priorityCompanies.map(c => c.toLowerCase().trim()))

    // Build location WHERE using the resolver's expanded terms
    const locationWhere = hasLocations
      ? {
          OR: [
            // Jobs with no location are always included (better to analyse than miss)
            { location: null },
            { location: '' },
            // Match any of the EXPANDED location terms (e.g. "Ireland" → Dublin, Cork, Galway...)
            ...locResolved.allDbTerms.map(term => ({
              location: { contains: term, mode: 'insensitive' as const },
            })),
            // Priority companies bypass location filter entirely
            ...(agentCfg.priorityCompanies.length > 0
              ? [{ company: { in: agentCfg.priorityCompanies } }]
              : []),
          ],
        }
      : {}

    const allSaved = await db.job.findMany({
      where: {
        userId,
        status: 'saved',
        NOT: excludeSet.size > 0 ? { company: { in: [...excludeSet] } } : undefined,
        ...locationWhere,
      },
      orderBy: [
        { score: 'asc' },
        { createdAt: 'desc' },
      ],
    })
    assertSignalActive(ctx)

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

    // Emit location resolution summary
    if (hasLocations) {
      const expandedCities = locResolved.allDbTerms.slice(0, 8)
      emit('agent_observation', {
        role:        'scout',
        observation: `📍 location analysis: [${agentCfg.targetLocations.join(', ')}] → Expand to ${expandedCities.length} matching words(${expandedCities.slice(0, 5).join(', ')}${expandedCities.length > 5 ? '…' : ''})`,
      })
    }

    // Emit formatted job list
    if (jobs.length > 0) {
      const jobList = jobs.slice(0, 10).map(j =>
        `- **${j.company}** · ${j.role}${j.location ? ` · 📍${j.location}` : ''}${j.score != null ? ` · ${j.score}%` : ' · Not rated'}`
      ).join('\n') + (jobs.length > 10 ? `\n- …and ${jobs.length - 10} more` : '')

      emit('agent_observation', {
        role:        'scout',
        observation: `📋 Enter analysis queue(common ${jobs.length} indivual): \n${jobList}`,
      })
    } else if (hasLocations) {
      // Zero results — emit a question via orchestrator
      const savedTotal = await db.job.count({ where: { userId, status: 'saved' } })
      assertSignalActive(ctx)
      if (savedTotal > 0) {
        emit('agent_question', {
          role:       'scout',
          questionId: 'no_local_jobs',
          question:   `saved ${savedTotal} None of the positions match [${agentCfg.targetLocations.join(', ')}] position, and API No new positions were found in the search.\n\nsuggestion: `,
          options: [
            { label: `🌍 Remove location restrictions, Analyze all ${savedTotal} positions`, value: 'remove_location', action: { field: 'targetLocations', value: [] } },
            { label: '✏ go Search Jobs Page manual search',                   value: 'goto_search',   action: { field: '_navigate', value: 'search' } },
            { label: '✕ Abort this run',                                   value: 'abort' },
          ],
        })
      }
    }

    return stageOk('scout', { jobs, discovered }, jobs.length, Date.now() - t0)

  } catch (error) {
    if (error instanceof AgentExecutionCancelledError) throw error
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
