/**
 * Stage 6 — Audit
 * Role: 审计员
 * Verifies DB state matches expected outcomes and produces the final RunReport.
 */
import { db } from '@/lib/db'
import type { Job }  from '@prisma/client'
import type {
  PipelineCtx, ExecuteOutput, AuditOutput, RunReport, StageResult,
} from '../types'
import { stageOk } from '../types'

export async function runAudit(
  executeOutput: ExecuteOutput,
  originalJobs:  Job[],
  ctx:           PipelineCtx,
): Promise<StageResult<AuditOutput>> {
  const t0 = Date.now()
  const warnings: string[] = []

  // Verify each applied job actually has status='applied' in DB
  if (executeOutput.applied.length > 0) {
    const dbJobs = await db.job.findMany({
      where:  { id: { in: executeOutput.applied } },
      select: { id: true, status: true, appliedAt: true },
    })

    for (const dbJob of dbJobs) {
      if (dbJob.status !== 'applied') {
        warnings.push(`Job ${dbJob.id} expected status=applied, got ${dbJob.status}`)
      }
      if (!dbJob.appliedAt) {
        warnings.push(`Job ${dbJob.id} missing appliedAt timestamp`)
      }
    }

    if (dbJobs.length !== executeOutput.applied.length) {
      warnings.push(
        `DB returned ${dbJobs.length} jobs but execute reported ${executeOutput.applied.length}`
      )
    }
  }

  // Compute RunReport
  const processed = originalJobs.length
  const applied   = executeOutput.applied.length
  const failed    = executeOutput.failed.length

  // pending = jobs that were in above-threshold packages but not auto-applied
  // We can approximate: processed - applied - failed - skipped_by_analyze
  // The exact pending count is passed via pipeline context, so we compute from what we have
  const pending = 0 // computed accurately in pipeline.ts from gate output
  const skipped = processed - applied - failed - pending

  const report: RunReport = {
    processed,
    applied,
    pending,
    skipped: Math.max(0, skipped),
    failed,
    durationMs: Date.now() - t0,
  }

  if (warnings.length > 0) {
    console.warn('[audit] warnings:', warnings)
  }

  return stageOk('audit', { report, warnings }, 1, Date.now() - t0)
}
