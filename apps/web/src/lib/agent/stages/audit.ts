/**
 * Stage 6 — Audit
 *
 * Verifies that the executor kept candidate-facing status separate from the
 * internal ready-to-apply workflow, then delegates all Gmail work to the
 * shared durable sync service. Gmail evidence must never be scanned or mapped
 * independently here: the sync service owns deduplication, matching, status
 * projection, activity records, and notifications.
 */
import type { Job } from '@prisma/client'
import { db } from '@/lib/db'
import { syncGmailForUser, type GmailSyncResult } from '@/lib/gmail-tracking/sync'
import type { AuditOutput, ExecuteOutput, PipelineCtx, RunReport, StageResult } from '../types'
import { stageOk } from '../types'

export async function runAudit(
  executeOutput: ExecuteOutput,
  originalJobs: Job[],
  ctx: PipelineCtx,
): Promise<StageResult<AuditOutput>> {
  const startedAt = Date.now()
  const warnings = await verifyReadyToApplyJobs(executeOutput.applied, ctx)
  await syncGmailTracking(ctx, warnings)

  const processed = originalJobs.length
  const applied = executeOutput.applied.length
  const failed = executeOutput.failed.length
  const skipped = Math.max(0, processed - applied - failed)
  const report: RunReport = {
    processed,
    applied,
    pending: 0,
    skipped,
    failed,
    durationMs: Date.now() - startedAt,
  }

  return stageOk('audit', { report, warnings }, 1, report.durationMs)
}

async function verifyReadyToApplyJobs(jobIds: string[], ctx: PipelineCtx): Promise<string[]> {
  if (jobIds.length === 0) return []

  const jobs = await db.job.findMany({
    where: { id: { in: jobIds } },
    select: {
      company: true,
      role: true,
      status: true,
      workflowState: true,
    },
  })
  const warnings: string[] = []

  for (const job of jobs) {
    const isReadyToApply = job.status === 'saved' && job.workflowState === 'ready_to_apply'
    if (!isReadyToApply) {
      warnings.push(`${job.company} · ${job.role}: expected Saved + ready-to-apply workflow`)
    }
  }

  if (jobs.length !== jobIds.length) {
    warnings.push(`${jobIds.length - jobs.length} queued job(s) could not be found during audit`)
  }

  ctx.emit('agent_observation', {
    role: 'auditor',
    observation: warnings.length
      ? `DB verification: ${jobs.length} queued job(s), ${warnings.length} warning(s)`
      : `DB verification: ${jobs.length} job(s) are saved and ready to apply`,
  })
  return warnings
}

async function syncGmailTracking(ctx: PipelineCtx, warnings: string[]): Promise<void> {
  let result: GmailSyncResult
  try {
    result = await syncGmailForUser(ctx.userId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Gmail sync failure'
    warnings.push(`Gmail sync failed: ${message}`)
    ctx.emit('agent_observation', {
      role: 'auditor',
      observation: '⚠ Gmail tracking could not be synced during this audit',
    })
    return
  }

  if (!result.connected) {
    ctx.emit('agent_observation', {
      role: 'auditor',
      observation: '⚠ Gmail is not connected — connect Google to track application replies and recommendations.',
    })
    return
  }

  if (result.error) {
    warnings.push(`Gmail sync failed: ${result.error}`)
    ctx.emit('agent_observation', {
      role: 'auditor',
      observation: '⚠ Gmail tracking returned an error; existing job statuses were not changed by this audit.',
    })
    return
  }

  if (result.importedMessages === 0 && result.newRecommendations === 0) {
    ctx.emit('agent_observation', {
      role: 'auditor',
      observation: '📬 Gmail sync complete — no new tracked messages or recommendations.',
    })
    return
  }

  ctx.emit('agent_observation', {
    role: 'auditor',
    observation: `📬 Gmail sync: ${result.importedMessages} new message(s), ${result.matchedMessages} matched, ${result.statusUpdates} application update(s), ${result.newRecommendations} recommendation(s).`,
  })
}
