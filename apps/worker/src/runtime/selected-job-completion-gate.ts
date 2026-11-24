import type { TaskGraphCommandPort, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import type { AgentArtifactDraftHead, AgentArtifactDraftHeadScope, AgentArtifactReviewReceipt, AgentArtifactReviewReceiptScope } from "../db/agent-artifact-repo.js"
import {
  selectedJobReviewedDraftEvidenceWithWitness,
  type SelectedJobArtifactCompletionGateWithWitnessResult,
} from "./subagents/selected-job-reviewed-draft-evidence.js"

export type { SelectedJobCompletionGraphWitness, SelectedJobArtifactCompletionGateWithWitnessResult } from "./subagents/selected-job-reviewed-draft-evidence.js"

const BLOCKED: Extract<TurnEngineCompletionGateResult, { ok: false }> = Object.freeze({
  ok: false,
  blocker: "selected_job_draft_review_required",
  feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
})

/** The active-turn adapter keeps the existing lease-fenced graph read before shared evidence checks. */
export async function selectedJobArtifactCompletionGateWithWitness(input: {
  readonly commandPort: Pick<TaskGraphCommandPort, "readCurrent"> | undefined
  readonly lease: TurnLease
  readonly root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  readonly selectedJobId: string | undefined
  readonly readCurrentDraftHead: ((scope: AgentArtifactDraftHeadScope) => Promise<AgentArtifactDraftHead | null>) | undefined
  readonly readCurrentSourceDigest: (() => Promise<string | null>) | undefined
  readonly readCurrentReviewReceipt: ((scope: AgentArtifactReviewReceiptScope) => Promise<AgentArtifactReviewReceipt | null>) | undefined
}): Promise<SelectedJobArtifactCompletionGateWithWitnessResult> {
  if (!input.commandPort || !input.selectedJobId?.trim() || input.selectedJobId.length > 256
    || !input.readCurrentDraftHead || !input.readCurrentSourceDigest || !input.readCurrentReviewReceipt) return BLOCKED
  const scope: TaskGraphReadScope = {
    userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
    rootTaskId: input.root.id, parentTaskId: input.root.id,
    turnLeaseOwner: input.lease.ownerId, turnLeaseVersion: input.lease.leaseVersion,
    parentLeaseOwner: input.lease.ownerId, parentAttemptCount: input.root.attemptCount,
  }
  try {
    const graph = await input.commandPort.readCurrent(scope)
    return await selectedJobReviewedDraftEvidenceWithWitness({
      graph, userId: input.lease.userId, sessionId: input.lease.sessionId, selectedJobId: input.selectedJobId,
      readCurrentDraftHead: input.readCurrentDraftHead,
      readCurrentSourceDigest: input.readCurrentSourceDigest,
      readCurrentReviewReceipt: input.readCurrentReviewReceipt,
    })
  } catch {
    return BLOCKED
  }
}

export async function selectedJobArtifactCompletionGate(
  input: Parameters<typeof selectedJobArtifactCompletionGateWithWitness>[0],
): Promise<TurnEngineCompletionGateResult> {
  const result = await selectedJobArtifactCompletionGateWithWitness(input)
  return result.ok ? { ok: true } : result
}
