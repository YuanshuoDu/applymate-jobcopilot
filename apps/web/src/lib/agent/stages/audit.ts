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
  options: Readonly<{ syncGmail?: boolean }> = {},
): Promise<StageResult<AuditOutput>> {
  const startedAt = Date.now()
  const emit = (observation: string) => ctx.emit('agent_observation', { role: 'auditor', observation })
  const warnings = await verifyDispatchedJobs(executeOutput.queued, emit)
  if (options.syncGmail !== false) await syncGmailTracking(ctx.userId, warnings, emit)

  const processed = originalJobs.length
  const queued = executeOutput.queued.length
  const failed = executeOutput.failed.length
  const skipped = Math.max(0, processed - queued - failed)
  const report: RunReport = {
    processed,
    applied: 0,
    queued,
    pending: 0,
    skipped,
    failed,
    durationMs: Date.now() - startedAt,
  }

  return stageOk('audit', { report, warnings }, 1, report.durationMs)
}

export async function runScheduledAudit(input: {
  userId: string
  executeOutput: ExecuteOutput
  assertCurrent: () => Promise<boolean>
}): Promise<{ warnings: string[]; observations: string[]; durationMs: number } | null> {
  if (typeof input.userId !== 'string' || input.userId.trim().length === 0) return null
  const startedAt = Date.now(), observations: string[] = []
  const emit = (observation: string) => observations.push(observation)
  const warnings = await verifyDispatchedJobs(input.executeOutput.queued, emit, input.userId)
  if (!await input.assertCurrent()) return null
  await syncGmailTracking(input.userId, warnings, emit)
  return { warnings, observations, durationMs: Date.now() - startedAt }
}

async function verifyDispatchedJobs(jobIds: string[], emit: (observation: string) => void, userId?: string): Promise<string[]> {
  if (jobIds.length === 0) return []

  const jobs = await db.job.findMany({
    where: userId === undefined ? { id: { in: jobIds } } : { userId, id: { in: jobIds } },
    select: {
      company: true,
      role: true,
      status: true,
      workflowState: true,
    },
  })
  const warnings: string[] = []

  for (const job of jobs) {
    const dispatched =
      (job.status === 'saved' && job.workflowState === 'queued') ||
      (job.status === 'saved' && job.workflowState === 'submitting') ||
      (job.status === 'applied' && job.workflowState === 'submitted')
    if (!dispatched) {
      warnings.push(`${job.company} · ${job.role}: expected queued, submitting, or confirmed-submitted workflow`)
    }
  }

  if (jobs.length !== jobIds.length) {
    warnings.push(`${jobIds.length - jobs.length} queued job(s) could not be found during audit`)
  }

  emit(warnings.length
    ? `DB verification: ${jobs.length} dispatched job(s), ${warnings.length} warning(s)`
    : `DB verification: ${jobs.length} job(s) are queued, submitting, or already confirmed submitted`)
  return warnings
}

async function syncGmailTracking(userId: string, warnings: string[], emit: (observation: string) => void): Promise<void> {
  let result: GmailSyncResult
  try {
    result = await syncGmailForUser(userId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Gmail sync failure'
    warnings.push(`Gmail sync failed: ${message}`)
    emit('⚠ Gmail tracking could not be synced during this audit')
    return
  }

  if (!result.connected) {
    emit('⚠ Gmail is not connected — connect Google to track application replies and recommendations.')
    return
  }

  if (result.error) {
    warnings.push(`Gmail sync failed: ${result.error}`)
    emit('⚠ Gmail tracking returned an error; existing job statuses were not changed by this audit.')
    return
  }

  if (result.importedMessages === 0 && result.newRecommendations === 0) {
    emit('📬 Gmail sync complete — no new tracked messages or recommendations.')
    return
  }

  emit(`📬 Gmail sync: ${result.importedMessages} new message(s), ${result.matchedMessages} matched, ${result.statusUpdates} application update(s), ${result.newRecommendations} recommendation(s).`)
}
