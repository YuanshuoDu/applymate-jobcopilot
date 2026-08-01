/**
 * Agent Pipeline — Orchestrated by OrchestratorAgent
 *
 * The OrchestratorAgent is the master harness that:
 *   1. Plans the run strategy before starting
 *   2. Dispatches each SubAgent stage
 *   3. Evaluates output quality after each stage
 *   4. Diagnoses failures and applies fixes
 *   5. Retries failed stages with patched context
 *   6. Decides skip / abort when retries are exhausted
 *
 *   Scout → Analyze → Prepare → Gate → Execute → Audit
 */
import { runScout,   acceptScout   } from './stages/scout'
import { runAnalyze, acceptAnalyze } from './stages/analyze'
import { runPrepare, acceptPrepare } from './stages/prepare'
import { runGate                   } from './stages/gate'
import { runExecute, acceptExecute } from './stages/execute'
import { runAudit                  } from './stages/audit'
import { recordRoleRun, ROLE_META  } from './role-config'
import { runCustomAgents, summarizeCustomAgentResults } from './stages/custom'
import { OrchestratorAgent         } from './orchestrator'
import type { ApplicationPackage, CustomAgentRunResult, ExecuteOutput, GateOutput, PipelineCheckpointState, PipelineCtx, RunReport, ScoredJob } from './types'
import { emptyReport } from './types'

export type { PipelineCtx }

function emitRole(ctx: PipelineCtx, role: string, event: 'start' | 'done', extra: Record<string, unknown> = {}) {
  const meta  = ROLE_META[role as keyof typeof ROLE_META]
  const model = ctx.roleConfigs[role as keyof typeof ctx.roleConfigs]?.model ?? ctx.aiConfig.model
  if (event === 'start') {
    ctx.emit('role_start', { role, label: meta?.zh ?? role, model, icon: meta?.icon ?? '' })
  } else {
    ctx.emit('role_done', { role, icon: meta?.icon ?? '', ...extra })
  }
}

const STAGE_ORDER = { scout: 0, analyze: 1, prepare: 2, gate: 3, execute: 4, audit: 5, completed: 6 } as const

function needsStage(state: PipelineCheckpointState, stage: keyof typeof STAGE_ORDER) {
  return STAGE_ORDER[state.nextStage] <= STAGE_ORDER[stage]
}

export async function runPipeline(ctx: PipelineCtx): Promise<RunReport> {
  const t0   = Date.now()
  const orch = new OrchestratorAgent(ctx, ctx.autonomous ?? false)
  const controlledCtx: PipelineCtx = {
    ...ctx,
    askUser: async (stage, question, options) => {
      const answer = await orch.ask(stage, question, options)
      await orch.applyOptionAction(answer, options)
      return answer
    },
  }
  const { emit } = ctx
  let state: PipelineCheckpointState = ctx.resumeState ?? { nextStage: 'scout', startedAt: new Date().toISOString() }
  let customAgentResults: CustomAgentRunResult[] = state.customAgentResults ?? []
  const persist = async (nextStage: PipelineCheckpointState['nextStage'], patch: Partial<PipelineCheckpointState> = {}) => {
    state = { ...state, ...patch, customAgentResults, nextStage }
    await ctx.checkpoint?.(state)
  }
  const collectCustomResults = async (jobs: Parameters<typeof runCustomAgents>[1], afterStage: string) => {
    const results = await runCustomAgents(controlledCtx, jobs, afterStage)
    if (Array.isArray(results)) customAgentResults = [...customAgentResults, ...results]
  }

  // ── Orchestrator: plan ─────────────────────────────────────────────────────
  await orch.plan()

  // ── Stage 1: Scout ─────────────────────────────────────────────────────────
  const hasTargets = ctx.agentCfg.targetRoles.length > 0
  let scoutedJobs = state.scoutedJobs ?? []
  let scoutDiscovered = 0
  if (needsStage(state, 'scout')) {
  orch.beginStage('scout', 3)
  emitRole(ctx, 'scout', 'start')
  emit('agent_plan', {
    role: 'scout',
    plan: hasTargets
      ? `计划：发现匹配 [${ctx.agentCfg.targetRoles.slice(0, 3).join(', ')}] 的新职位，然后加载已保存职位，应用过滤条件（排除 ${ctx.agentCfg.excludeCompanies.length} 家公司，每日上限 ${ctx.agentCfg.dailyLimit} 条）`
      : `计划：加载所有已保存职位，应用排除/去重/每日上限过滤条件`,
  })
  await persist('scout')

  scoutLoop: while (true) {
    const attempt = orch.nextAttempt('scout')
    if (attempt > 1) orch.emitRetry('scout', attempt, 3, '重新扫描职位…')

    const s1 = await runScout(ctx)
    const a1 = acceptScout(s1)

    if (!a1.ok) {
      orch.recordFailure('scout', a1.reason ?? 'Scout failed')
      if (orch.isExhausted('scout')) {
        const decision = await orch.decideOnExhaustion('scout', a1.reason ?? '', { jobsProcessed: 0 })
        if (decision === 'abort') { emit('done', emptyReport(Date.now() - t0)); return emptyReport(Date.now() - t0) }
        break scoutLoop
      }
      orch.applyFix('scout', 'scout_failed')
      continue
    }

    // True LLM evaluation of scout output
    const dec1 = await orch.evaluate('scout',
      `Found ${s1.data!.jobs.length} jobs (${scoutDiscovered} new discovered)`,
      { jobCount: s1.data!.jobs.length, discovered: scoutDiscovered, targetRoles: ctx.agentCfg.targetRoles.length },
    )
    if (dec1.decision === 'abort') {
      emit('done', emptyReport(Date.now() - t0)); return emptyReport(Date.now() - t0)
    }
    if (dec1.decision === 'ask_user' && dec1.ask_question) {
      const answer = await orch.ask('scout', dec1.ask_question, dec1.ask_options ?? [
        { label: '继续', value: 'continue' },
        { label: '中止', value: 'abort' },
      ])
      if (answer === 'abort') { emit('done', emptyReport(Date.now() - t0)); return emptyReport(Date.now() - t0) }
      // Apply option action if any
      await orch.applyOptionAction(answer, dec1.ask_options ?? [])
    }
    if (dec1.decision === 'retry' && dec1.retry_fix && attempt < 3) {
      orch.applyFix(dec1.retry_fix, 'scout')
      continue
    }

    scoutedJobs     = s1.data!.jobs
    scoutDiscovered = s1.data!.discovered
    const scoutSummary = scoutDiscovered > 0
      ? `Discovered ${scoutDiscovered} new jobs, ${scoutedJobs.length} total queued`
      : `${scoutedJobs.length} saved jobs queued`

    emit('agent_reflect', {
      role: 'scout',
      reflect: `侦察完成：${scoutDiscovered > 0 ? `发现 ${scoutDiscovered} 个新职位，` : ''}共 ${scoutedJobs.length} 个职位进入分析队列（耗时 ${(s1.metrics.durationMs / 1000).toFixed(1)}s）`,
    })
    emitRole(ctx, 'scout', 'done', { count: scoutedJobs.length, discovered: scoutDiscovered, durationMs: s1.metrics.durationMs, summary: scoutSummary })
    emit('stage_done', { stage: 'scout', count: scoutedJobs.length, durationMs: s1.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'scout', { count: scoutedJobs.length, durationMs: s1.metrics.durationMs, summary: scoutSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'scout')
    await persist('analyze', { scoutedJobs })
    break scoutLoop
  }
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; Scout result restored (${scoutedJobs.length} jobs).` })
  }

  if (scoutedJobs.length === 0) {
    const msg = hasTargets
      ? 'No jobs found. Try broadening your target roles or locations in Settings.'
      : 'No saved jobs to process. Configure target roles in Settings so the agent can discover jobs automatically.'
    emit('info', { message: msg })
    emit('done', emptyReport(Date.now() - t0))
    return emptyReport(Date.now() - t0)
  }

  emit('start', { total: scoutedJobs.length })

  // ── Stage 2: Analyze ───────────────────────────────────────────────────────
  let scoredJobs: ScoredJob[] = state.scoredJobs ?? []
  let analysisFailed = state.analysisFailed ?? 0
  if (needsStage(state, 'analyze')) {
  orch.beginStage('analyst', 2)
  emitRole(ctx, 'analyst', 'start')
  emit('agent_plan', {
    role: 'analyst',
    plan: `计划：对 ${scoutedJobs.length} 个职位逐一进行 AI 匹配评分，提取匹配/缺失关键词（最低分阈值：${ctx.agentCfg.minMatchScore}%）`,
  })
  await persist('analyze', { scoutedJobs })

  analyzeLoop: while (true) {
    const attempt = orch.nextAttempt('analyst')
    if (attempt > 1) orch.emitRetry('analyst', attempt, 2, '切换备用模型重新评分…')

    const s2 = await runAnalyze(scoutedJobs, controlledCtx)
    const a2 = acceptAnalyze(s2)

    if (!a2.ok || !s2.data) {
      orch.recordFailure('analyst', a2.ok ? 'No data' : a2.reason)
      if (orch.isExhausted('analyst')) {
        const decision = await orch.decideOnExhaustion('analyst', 'All scoring failed', { jobsProcessed: 0 })
        if (decision === 'abort') { emit('done', emptyReport(Date.now() - t0)); return emptyReport(Date.now() - t0) }
        break analyzeLoop
      }
      orch.applyFix('analyst', 'all_scoring_failed')
      continue
    }

    // True LLM evaluation of analyst output
    const avgScoreEval = s2.data.scoredJobs.length
      ? Math.round(s2.data.scoredJobs.reduce((s, j) => s + j.score, 0) / s2.data.scoredJobs.length)
      : 0
    const aboveEval = s2.data.scoredJobs.filter(j => j.score >= ctx.agentCfg.minMatchScore).length
    const dec2 = await orch.evaluate('analyst',
      `Scored ${s2.data.scoredJobs.length}/${scoutedJobs.length} jobs, avg ${avgScoreEval}%, ${aboveEval} above threshold, ${s2.data.failed ?? 0} failed`,
      { scored: s2.data.scoredJobs.length, avgScore: avgScoreEval, aboveThreshold: aboveEval, failed: s2.data.failed ?? 0, threshold: ctx.agentCfg.minMatchScore },
    )
    if (dec2.decision === 'abort') {
      emit('done', emptyReport(Date.now() - t0)); return emptyReport(Date.now() - t0)
    }
    if (dec2.decision === 'ask_user' && dec2.ask_question) {
      const answer = await orch.ask('analyst', dec2.ask_question, dec2.ask_options ?? [
        { label: '继续', value: 'continue' },
        { label: '降低阈值 5%', value: 'lower', action: { field: 'minMatchScore', value: Math.max(40, ctx.agentCfg.minMatchScore - 5) } },
      ])
      await orch.applyOptionAction(answer, dec2.ask_options ?? [])
      if (answer === 'abort') { emit('done', emptyReport(Date.now() - t0)); return emptyReport(Date.now() - t0) }
    }
    if (dec2.decision === 'retry' && dec2.retry_fix && attempt < 2) {
      orch.applyFix(dec2.retry_fix, 'analyst')
      continue
    }

    scoredJobs    = s2.data.scoredJobs
    analysisFailed = s2.data.failed ?? 0
    const avgScore = scoredJobs.length
      ? Math.round(scoredJobs.reduce((sum, j) => sum + j.score, 0) / scoredJobs.length)
      : 0
    const aboveThreshold = scoredJobs.filter(j => j.score >= ctx.agentCfg.minMatchScore).length
    const analystSummary = `${scoredJobs.length} scored, avg ${avgScore}%`

    emit('agent_reflect', {
      role: 'analyst',
      reflect: `分析完成：${scoredJobs.length} 个已评分，平均分 ${avgScore}%，${aboveThreshold} 个达到阈值（≥${ctx.agentCfg.minMatchScore}%），${analysisFailed} 个失败（耗时 ${(s2.metrics.durationMs / 1000).toFixed(1)}s）`,
    })
    emitRole(ctx, 'analyst', 'done', { count: scoredJobs.length, durationMs: s2.metrics.durationMs, summary: analystSummary, avgScore })
    emit('stage_done', { stage: 'analyze', count: scoredJobs.length, durationMs: s2.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'analyst', { count: scoredJobs.length, durationMs: s2.metrics.durationMs, summary: analystSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'analyst')

    await persist('prepare', { scoutedJobs, scoredJobs, analysisFailed })
    break analyzeLoop
  }
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; match analysis restored (${scoredJobs.length} jobs).` })
  }

  if (scoredJobs.length === 0) {
    emit('info', { message: 'No jobs scored successfully. Check AI API keys.' })
    orch.complete({ processed: scoutedJobs.length, applied: 0, queued: 0, pending: 0, skipped: scoutedJobs.length })
    emit('done', emptyReport(Date.now() - t0))
    return emptyReport(Date.now() - t0)
  }

  // ── Stage 3: Prepare (Writer) ──────────────────────────────────────────────
  let preparedPackages: ApplicationPackage[] = state.preparedPackages ?? []
  if (needsStage(state, 'prepare')) {
  orch.beginStage('writer', 2)
  emitRole(ctx, 'writer', 'start')
  const qualifiedCount = scoredJobs.filter(j => j.score >= ctx.agentCfg.minMatchScore).length
  emit('agent_plan', {
    role: 'writer',
    plan: ctx.agentCfg.autoCoverLetter
      ? `计划：为 ${qualifiedCount} 个达标职位生成定制求职信（语调：${ctx.agentCfg.coverTone || 'professional'}）`
      : `计划：为 ${qualifiedCount} 个达标职位准备申请材料`,
  })
  await persist('prepare', { scoutedJobs, scoredJobs, analysisFailed })

  let allowResumeTailoring = true

  // Resume tailoring creates a new candidate artifact. Keep that mutation behind
  // an explicit user gate; the Reviewer remains a separate final approval gate.
  if (ctx.agentCfg.requireApproval) {
    const decision = await orch.ask('writer',
      `Writer 准备为 ${qualifiedCount} 个达标职位应用 AI 修改，生成定制简历并保留职位与模板连接。是否继续？`,
      [
        { label: '应用 AI 修改并生成定制简历', value: 'apply_ai_changes' },
        { label: '仅生成求职信，简历保持不变', value: 'keep_resume' },
      ],
    )
    allowResumeTailoring = decision === 'apply_ai_changes'
    if (!allowResumeTailoring) {
      emit('agent_observation', {
        role: 'writer',
        observation: '已保留原简历；Writer 只会准备不修改简历的申请材料。',
      })
    }
  }

  prepareLoop: while (true) {
    const attempt = orch.nextAttempt('writer')
    if (attempt > 1) orch.emitRetry('writer', attempt, 2, '使用简化模板重新生成求职信…')

    const s3 = await runPrepare(scoredJobs, controlledCtx, { allowResumeTailoring })
    // Prepare is non-fatal; acceptPrepare returns ok=true even with partial failures
    const lettersCount = s3.data!.packages.filter(p => p.coverLetter).length
    const writerSummary = ctx.agentCfg.autoCoverLetter
      ? `${lettersCount} cover letters generated`
      : `${s3.data!.packages.length} packages prepared`

    if (ctx.agentCfg.autoCoverLetter && lettersCount === 0 && qualifiedCount > 0 && attempt < 2) {
      orch.applyFix('writer', 'cover_letter_generation_failed')
      emit('orchestrator_fix', {
        stage: 'writer', fix: 'retry_cover_letters',
        message: '求职信生成全部失败，正在重试（可能是 API 临时异常）…',
      })
      continue
    }

    preparedPackages = s3.data!.packages
    emit('agent_reflect', {
      role: 'writer',
      reflect: ctx.agentCfg.autoCoverLetter
        ? `撰写完成：生成 ${lettersCount} 封求职信，${preparedPackages.length - lettersCount} 个无需生成（耗时 ${(s3.metrics.durationMs / 1000).toFixed(1)}s）`
        : `材料准备完成：${preparedPackages.length} 个申请包已就绪（耗时 ${(s3.metrics.durationMs / 1000).toFixed(1)}s）`,
    })
    emitRole(ctx, 'writer', 'done', { count: preparedPackages.length, durationMs: s3.metrics.durationMs, summary: writerSummary, letters: lettersCount })
    emit('stage_done', { stage: 'prepare', count: preparedPackages.length, durationMs: s3.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'writer', { count: preparedPackages.length, durationMs: s3.metrics.durationMs, summary: writerSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'writer')
    await persist('gate', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages })
    break prepareLoop
  }
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; application materials restored (${preparedPackages.length} packages).` })
  }

  // ── Stage 4: Gate (Reviewer) ───────────────────────────────────────────────
  let gateOutput: GateOutput = state.gateOutput ?? { approved: [], pending: [], skipped: [] }
  if (needsStage(state, 'gate')) {
  orch.beginStage('reviewer', 1)
  emitRole(ctx, 'reviewer', 'start')
  const gateRule = ctx.agentCfg.autoApply && !ctx.agentCfg.requireApproval
    ? `自动投递模式：分 ≥ ${ctx.agentCfg.minMatchScore}% → 直接投递，否则待审核`
    : '手动审核模式：所有职位进入待审核队列'
  emit('agent_plan', {
    role: 'reviewer',
    plan: `计划：对 ${preparedPackages.length} 个申请包执行 AI 质量审查 + 分流决策。规则：${gateRule}`,
  })
  await persist('gate', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages })

    const s4 = await runGate(preparedPackages, controlledCtx)
  gateOutput = s4.data ?? gateOutput

  const reviewerSummary = `${gateOutput.approved.length} approved, ${gateOutput.pending.length} pending, ${gateOutput.skipped.length} skipped`
  emit('agent_reflect', {
    role: 'reviewer',
    reflect: `审核完成：${gateOutput.approved.length} 个批准进入申请队列，${gateOutput.pending.length} 个待审核，${gateOutput.skipped.length} 个低于阈值跳过（耗时 ${(s4.metrics.durationMs / 1000).toFixed(1)}s）`,
  })
  emitRole(ctx, 'reviewer', 'done', { count: gateOutput.approved.length + gateOutput.pending.length, durationMs: s4.metrics.durationMs, summary: reviewerSummary, approved: gateOutput.approved.length, pending: gateOutput.pending.length })
  emit('stage_done', { stage: 'gate', approved: gateOutput.approved.length, pending: gateOutput.pending.length, skipped: gateOutput.skipped.length, durationMs: s4.metrics.durationMs })
  await recordRoleRun(ctx.userId, 'reviewer', { count: gateOutput.approved.length + gateOutput.pending.length, durationMs: s4.metrics.durationMs, summary: reviewerSummary }).catch(() => {})
  await collectCustomResults(scoutedJobs, 'reviewer')

  // Persist the internal readiness signal without inventing an employer-facing
  // "in review" application status.
  if (gateOutput.pending.length > 0) {
    emit('info', { message: `${gateOutput.pending.length} job(s) are ready for your review in Saved jobs` })
    const { db } = await import('@/lib/db')
    for (const pkg of gateOutput.pending) {
      await db.job.update({ where: { id: pkg.job.id }, data: { status: 'saved', workflowState: 'ready_to_apply' } }).catch(() => {})
    }
  }

  // Orchestrator: if nothing approved AND nothing pending, flag it
  if (gateOutput.approved.length === 0 && gateOutput.pending.length === 0) {
    emit('orchestrator_decision', {
      stage: 'reviewer', decision: 'all_skipped',
      reason: `所有 ${gateOutput.skipped.length} 个职位均低于阈值 ${ctx.agentCfg.minMatchScore}%。建议降低阈值或完善简历。`,
    })
  }
  await persist('execute', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput })
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; review routing restored.` })
  }

  // ── Stage 5: Execute ───────────────────────────────────────────────────────
  let executeOutput: ExecuteOutput = state.executeOutput ?? { queued: [], failed: [] }
  let executorQueued: string[] = executeOutput.queued
  let executorFailed: string[] = executeOutput.failed
  if (needsStage(state, 'execute')) {
  orch.beginStage('executor', 3)
  emitRole(ctx, 'executor', 'start')
  emit('agent_plan', {
    role: 'executor',
    plan: gateOutput.approved.length > 0
      ? `计划：为 ${gateOutput.approved.length} 个批准职位准备「立即申请」队列，等待你手动确认投递`
      : `计划：无批准职位，${gateOutput.pending.length} 个在待审核队列等待人工操作`,
  })
  await persist('execute', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput })

  executeLoop: while (true) {
    const attempt = orch.nextAttempt('executor')
    if (attempt > 1) {
      const backoffMs = attempt * 1000
      await new Promise(r => setTimeout(r, backoffMs))
      orch.emitRetry('executor', attempt, 3, `DB 写入重试（等待 ${backoffMs}ms）…`)
    }

    const s5 = await runExecute(gateOutput.approved, ctx)

    // If the queue was temporarily unavailable, retry only the failed packages.
    if (s5.data!.failed.length > 0 && attempt < 3) {
      orch.recordFailure('executor', `${s5.data!.failed.length} queue operations failed`)
      // Re-run with only the failed jobs
      const failedPkgs = gateOutput.approved.filter(p => s5.data!.failed.includes(p.job.id))
      if (failedPkgs.length > 0) {
        emit('orchestrator_fix', {
          stage: 'executor', fix: 'retry_failed_db_writes',
          message: `${s5.data!.failed.length} 个投递任务入队失败，正在重试…`,
        })
        // Merge results
        executorQueued = [...executorQueued, ...s5.data!.queued]
        // Override approved list to only retry failed ones
        gateOutput.approved = failedPkgs
        continue
      }
    }

    executorQueued = [...executorQueued, ...s5.data!.queued]
    executorFailed  = [...executorFailed,  ...s5.data!.failed]

    emit('agent_reflect', {
      role: 'executor',
      reflect: executorQueued.length > 0
        ? `已派发：${executorQueued.length} 个职位已加入无人值守投递队列。提交确认会由 Worker 回写${executorFailed.length > 0 ? `（${executorFailed.length} 个入队失败）` : ''}（耗时 ${(s5.metrics.durationMs / 1000).toFixed(1)}s）`
        : `准备完成：无高分职位进入无人值守投递队列，所有职位仍在待审核`,
    })
    const executorSummary = `${executorQueued.length} queued for unattended submission, ${executorFailed.length} failed`
    emitRole(ctx, 'executor', 'done', { count: executorQueued.length, durationMs: s5.metrics.durationMs, summary: executorSummary, queued: executorQueued.length, failed: executorFailed.length })
    emit('stage_done', { stage: 'execute', queued: executorQueued.length, durationMs: s5.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'executor', { count: executorQueued.length, durationMs: s5.metrics.durationMs, summary: executorSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'executor')
    executeOutput = { queued: executorQueued, failed: executorFailed }
    await persist('audit', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput })
    break executeLoop
  }
  } else {
    emit('info', { message: `Resuming from ${state.nextStage}; executor outcome restored.` })
  }

  // ── Stage 6: Audit ─────────────────────────────────────────────────────────
  if (!needsStage(state, 'audit')) {
    const restored = state.report ?? emptyReport(Date.now() - t0)
    emit('info', { message: 'Agent run was already audited; returning the persisted final report.' })
    return restored
  }
  orch.beginStage('auditor', 2)
  emitRole(ctx, 'auditor', 'start')
  emit('agent_plan', {
    role: 'auditor',
    plan: `计划：核查 DB 状态，统计结果（${executorQueued.length} 已派发到无人值守 Worker / ${gateOutput.pending.length} 待审核 / ${gateOutput.skipped.length} 跳过），扫描 Gmail 邮件`,
  })
  await persist('audit', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput })

  let auditWarnings: string[] = []

  auditLoop: while (true) {
    const attempt = orch.nextAttempt('auditor')
    if (attempt > 1) {
      orch.emitRetry('auditor', attempt, 2, '跳过 Gmail 扫描，仅做 DB 核验…')
    }

    const fakeExecuteOutput = { queued: executorQueued, failed: executorFailed }
    const s6 = await runAudit(fakeExecuteOutput, scoutedJobs, ctx)
    auditWarnings = s6.data!.warnings ?? []

    if (auditWarnings.length > 0) {
      emit('info', { message: `Audit: ${auditWarnings.join('; ')}` })
    }

    const report: RunReport = {
      processed:  scoutedJobs.length,
      applied:    0,
      queued:     executorQueued.length,
      pending:    gateOutput.pending.length,
      skipped:    gateOutput.skipped.length + analysisFailed,
      failed:     executorFailed.length,
      durationMs: Date.now() - t0,
    }

    const auditorSummary = `${report.queued} dispatched, ${report.pending} pending, ${auditWarnings.length} warnings`
    emit('agent_reflect', {
      role: 'auditor',
      reflect: `✅ 本次运行报告：处理 ${report.processed} 个职位 · 🚀 已派发 ${report.queued} 个 · ✅ 已确认提交 ${report.applied} 个 · ⏳ 待审核 ${report.pending} 个 · ⏭ 跳过 ${report.skipped} 个 · ❌ 失败 ${report.failed} 个${auditWarnings.length > 0 ? ` · ⚠ ${auditWarnings.length} 个警告` : ''} · 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    })
    emitRole(ctx, 'auditor', 'done', { count: report.processed, durationMs: s6.metrics.durationMs, summary: auditorSummary, warnings: auditWarnings.length })
    emit('stage_done', { stage: 'audit', durationMs: s6.metrics.durationMs })
    await recordRoleRun(ctx.userId, 'auditor', { count: report.processed, durationMs: s6.metrics.durationMs, summary: auditorSummary }).catch(() => {})
    await collectCustomResults(scoutedJobs, 'auditor')
    const customSummary = summarizeCustomAgentResults(customAgentResults)
    if (customSummary.length > 0) {
      emit('custom_agent_summary', { findings: customSummary })
    }

    // ── Post-run LLM evaluation (true Orchestrator decision, not hardcoded) ──
    const postRunAvg = scoredJobs.length
      ? Math.round(scoredJobs.reduce((s, j) => s + j.score, 0) / scoredJobs.length)
      : 0
    const decPost = await orch.evaluate('post-run',
      `Complete: ${report.processed} processed, ${report.queued} dispatched, ${report.applied} confirmed submitted, ${report.pending} pending review, ${report.skipped} skipped, avg score ${postRunAvg}%`,
      { processed: report.processed, queued: report.queued, applied: report.applied, pending: report.pending, skipped: report.skipped, avgScore: postRunAvg, threshold: ctx.agentCfg.minMatchScore, autoApply: ctx.agentCfg.autoApply },
    )
    if (decPost.decision === 'ask_user' && decPost.ask_question) {
      const options = decPost.ask_options ?? [{ label: '✓ 了解', value: 'ok' }]
      const answer  = await orch.ask('post-run', decPost.ask_question, options)
      await orch.applyOptionAction(answer, options)
    }
    if (decPost.decision === 'retry' && decPost.retry_fix) {
      orch.applyFix(decPost.retry_fix, 'post-run')
    }

    // ── Orchestrator complete ─────────────────────────────────────────────────
    orch.complete({
      processed: report.processed,
      applied:   report.applied,
      queued:    report.queued,
      pending:   report.pending,
      skipped:   report.skipped,
    })

    emit('done', report)
    await persist('completed', { scoutedJobs, scoredJobs, analysisFailed, preparedPackages, gateOutput, executeOutput, report })
    return report
  }

  // Should never reach here, but TS needs it
  return emptyReport(Date.now() - t0)
}
