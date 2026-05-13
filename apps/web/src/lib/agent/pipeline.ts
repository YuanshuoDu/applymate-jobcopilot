/**
 * Agent Pipeline — Harness Runner
 *
 * Orchestrates the 6 stages in order, handles stage-level accept checks,
 * streams SSE progress events, and returns the final RunReport.
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
import type { PipelineCtx, RunReport } from './types'
import { emptyReport } from './types'

export type { PipelineCtx }

/** Emit role_start + role_done events that the Playground UI listens to. */
function emitRole(ctx: PipelineCtx, role: string, event: 'start' | 'done', extra: Record<string, unknown> = {}) {
  const meta = ROLE_META[role as keyof typeof ROLE_META]
  const model = ctx.roleConfigs[role as keyof typeof ctx.roleConfigs]?.model ?? ctx.aiConfig.model
  if (event === 'start') {
    ctx.emit('role_start', { role, label: meta?.zh ?? role, model, icon: meta?.icon ?? '' })
  } else {
    ctx.emit('role_done', { role, icon: meta?.icon ?? '', ...extra })
  }
}

export async function runPipeline(ctx: PipelineCtx): Promise<RunReport> {
  const t0 = Date.now()
  const { emit } = ctx

  // ── Stage 1: Scout ─────────────────────────────────────────────────────────
  emitRole(ctx, 'scout', 'start')
  const hasTargets = ctx.agentCfg.targetRoles.length > 0
  emit('stage_start', {
    stage: 'scout',
    label: hasTargets ? 'Discovering new jobs + scanning saved…' : 'Scanning saved jobs…',
  })
  const s1 = await runScout(ctx)
  const a1 = acceptScout(s1)
  if (!a1.ok) {
    emit('error', { message: `Scout failed: ${a1.reason}` })
    return { ...emptyReport(), durationMs: Date.now() - t0 }
  }
  const { jobs: scoutJobs, discovered } = s1.data!
  const scoutSummary = discovered > 0
    ? `Discovered ${discovered} new job${discovered === 1 ? '' : 's'}, ${scoutJobs.length} total queued`
    : `${scoutJobs.length} saved jobs queued`
  emitRole(ctx, 'scout', 'done', {
    count: scoutJobs.length, discovered,
    durationMs: s1.metrics.durationMs, summary: scoutSummary,
  })
  emit('stage_done', { stage: 'scout', count: s1.data!.jobs.length, durationMs: s1.metrics.durationMs })
  await recordRoleRun(ctx.userId, 'scout', { count: s1.data!.jobs.length, durationMs: s1.metrics.durationMs, summary: scoutSummary }).catch(() => {})

  const scoutedJobs = scoutJobs

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
  emitRole(ctx, 'analyst', 'start')
  emit('stage_start', { stage: 'analyze', label: `Scoring ${scoutedJobs.length} jobs with AI…` })
  const s2 = await runAnalyze(scoutedJobs, ctx)
  const a2 = acceptAnalyze(s2)
  if (!a2.ok) {
    emit('error', { message: `Analyze failed: ${a2.reason}` })
    return { ...emptyReport(), durationMs: Date.now() - t0 }
  }
  const avgScore = s2.data!.scoredJobs.length
    ? Math.round(s2.data!.scoredJobs.reduce((sum, j) => sum + j.score, 0) / s2.data!.scoredJobs.length)
    : 0
  const analystSummary = `${s2.data!.scoredJobs.length} scored, avg ${avgScore}%`
  emitRole(ctx, 'analyst', 'done', { count: s2.data!.scoredJobs.length, durationMs: s2.metrics.durationMs, summary: analystSummary, avgScore })
  emit('stage_done', { stage: 'analyze', count: s2.data!.scoredJobs.length, durationMs: s2.metrics.durationMs })
  await recordRoleRun(ctx.userId, 'analyst', { count: s2.data!.scoredJobs.length, durationMs: s2.metrics.durationMs, summary: analystSummary }).catch(() => {})

  // ── Stage 3: Prepare ───────────────────────────────────────────────────────
  emitRole(ctx, 'writer', 'start')
  emit('stage_start', { stage: 'prepare', label: 'Generating application materials…' })
  const s3 = await runPrepare(s2.data!.scoredJobs, ctx)
  const a3 = acceptPrepare(s3, ctx.agentCfg)
  if (!a3.ok) {
    emit('info', { message: `Prepare note: ${a3.reason}` })
  }
  const lettersCount = s3.data!.packages.filter(p => p.coverLetter).length
  const writerSummary = ctx.agentCfg.autoCoverLetter
    ? `${lettersCount} cover letters generated`
    : `${s3.data!.packages.length} packages prepared`
  emitRole(ctx, 'writer', 'done', { count: s3.data!.packages.length, durationMs: s3.metrics.durationMs, summary: writerSummary, letters: lettersCount })
  emit('stage_done', { stage: 'prepare', count: s3.data!.packages.length, durationMs: s3.metrics.durationMs })
  await recordRoleRun(ctx.userId, 'writer', { count: s3.data!.packages.length, durationMs: s3.metrics.durationMs, summary: writerSummary }).catch(() => {})

  // ── Stage 4: Gate ──────────────────────────────────────────────────────────
  emitRole(ctx, 'reviewer', 'start')
  emit('stage_start', { stage: 'gate', label: 'Applying review rules…' })
  const s4 = runGate(s3.data!.packages, ctx)
  const reviewerSummary = `${s4.data!.approved.length} approved, ${s4.data!.pending.length} pending review, ${s4.data!.skipped.length} skipped`
  emitRole(ctx, 'reviewer', 'done', { count: s4.data!.approved.length + s4.data!.pending.length, durationMs: s4.metrics.durationMs, summary: reviewerSummary, approved: s4.data!.approved.length, pending: s4.data!.pending.length })
  emit('stage_done', {
    stage:    'gate',
    approved: s4.data!.approved.length,
    pending:  s4.data!.pending.length,
    skipped:  s4.data!.skipped.length,
    durationMs: s4.metrics.durationMs,
  })
  await recordRoleRun(ctx.userId, 'reviewer', { count: s4.data!.approved.length + s4.data!.pending.length, durationMs: s4.metrics.durationMs, summary: reviewerSummary }).catch(() => {})

  // Emit pending notifications
  if (s4.data!.pending.length > 0) {
    emit('info', {
      message: `${s4.data!.pending.length} job(s) queued for review in your Jobs dashboard`,
    })
    // Mark pending jobs as status='review' so they appear in the review column
    const { db } = await import('@/lib/db')
    for (const pkg of s4.data!.pending) {
      await db.job.update({
        where: { id: pkg.job.id },
        data:  { status: 'review' },
      }).catch(() => { /* non-fatal */ })
    }
  }

  // ── Stage 5: Execute ───────────────────────────────────────────────────────
  emitRole(ctx, 'executor', 'start')
  emit('stage_start', {
    stage: 'execute',
    label: s4.data!.approved.length > 0
      ? `Auto-applying to ${s4.data!.approved.length} job(s)…`
      : 'No auto-apply — manual review required',
  })
  const s5 = await runExecute(s4.data!.approved, ctx)
  const a5 = acceptExecute(s5)
  if (!a5.ok) {
    emit('info', { message: `Execute warning: ${a5.reason}` })
  }
  const executorSummary = `${s5.data!.applied.length} applied, ${s5.data!.failed.length} failed`
  emitRole(ctx, 'executor', 'done', { count: s5.data!.applied.length, durationMs: s5.metrics.durationMs, summary: executorSummary, applied: s5.data!.applied.length, failed: s5.data!.failed.length })
  emit('stage_done', { stage: 'execute', applied: s5.data!.applied.length, durationMs: s5.metrics.durationMs })
  await recordRoleRun(ctx.userId, 'executor', { count: s5.data!.applied.length, durationMs: s5.metrics.durationMs, summary: executorSummary }).catch(() => {})

  // ── Stage 6: Audit ─────────────────────────────────────────────────────────
  emitRole(ctx, 'auditor', 'start')
  emit('stage_start', { stage: 'audit', label: 'Verifying and summarising…' })
  const s6 = await runAudit(s5.data!, scoutedJobs, ctx)
  const auditData = s6.data!

  // Build accurate final report (audit's skipped calc is approximated; use gate counts)
  const report: RunReport = {
    processed:  scoutedJobs.length,
    applied:    s5.data!.applied.length,
    pending:    s4.data!.pending.length,
    skipped:    s4.data!.skipped.length + (s2.data!.failed ?? 0),
    failed:     s5.data!.failed.length,
    durationMs: Date.now() - t0,
  }

  if (auditData.warnings.length > 0) {
    emit('info', { message: `Audit: ${auditData.warnings.join('; ')}` })
  }

  const auditorSummary = `${report.applied} applied, ${report.pending} pending, ${auditData.warnings.length} warnings`
  emitRole(ctx, 'auditor', 'done', { count: report.processed, durationMs: s6.metrics.durationMs, summary: auditorSummary, warnings: auditData.warnings.length })
  emit('stage_done', { stage: 'audit', durationMs: s6.metrics.durationMs })
  await recordRoleRun(ctx.userId, 'auditor', { count: report.processed, durationMs: s6.metrics.durationMs, summary: auditorSummary }).catch(() => {})
  emit('done', report)

  return report
}
