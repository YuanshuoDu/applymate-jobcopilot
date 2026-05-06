/**
 * Stage 4 — Gate
 * Role: 审核员
 * Distributes ApplicationPackages into three buckets:
 *   approved — auto-apply immediately (autoApply=true, requireApproval=false, score≥threshold)
 *   pending  — queued for human review (requireApproval=true, or score<autoApplyThreshold)
 *   skipped  — below minMatchScore (already filtered by Prepare, but double-check)
 *
 * Decision matrix:
 *   autoApply=false                       → all pending
 *   autoApply=true, requireApproval=true  → all pending (user must review first)
 *   autoApply=true, requireApproval=false → score≥minMatchScore → approved; else pending
 */
import type {
  PipelineCtx, ApplicationPackage, GateOutput, StageResult,
} from '../types'
import { stageOk } from '../types'

export function runGate(
  packages: ApplicationPackage[],
  ctx: PipelineCtx,
): StageResult<GateOutput> {
  const t0 = Date.now()
  const { autoApply, requireApproval, minMatchScore } = ctx.agentCfg

  const approved: ApplicationPackage[] = []
  const pending:  ApplicationPackage[] = []
  const skipped:  ApplicationPackage[] = []

  for (const pkg of packages) {
    if (pkg.score < minMatchScore) {
      skipped.push(pkg)
      continue
    }

    if (autoApply && !requireApproval) {
      approved.push(pkg)
    } else {
      // requireApproval=true OR autoApply=false → needs review
      pending.push(pkg)
    }
  }

  const total = Date.now() - t0
  return stageOk(
    'gate',
    { approved, pending, skipped },
    approved.length + pending.length + skipped.length,
    total,
  )
}
