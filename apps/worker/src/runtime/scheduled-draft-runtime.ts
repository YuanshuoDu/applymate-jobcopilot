import type pg from "pg"
import type { PoolClient } from "pg"
import { loadSelectedJobArtifactContext } from "./subagents/selected-job-artifact-context.js"
import {
  readScheduledDraftCandidateBinding,
  validateScheduledDraftCandidateWitness,
  type LoadedScheduledDraftCandidateBinding,
} from "./subagents/scheduled-draft-candidate.js"
import type { TaskGraphCommandPort, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { transaction } from "./subagents/pg-store-persistence.js"
import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import {
  createAgentArtifactRepository,
  findCurrentDraftHeadWithClient,
  findReviewReceiptWithClient,
  type AgentArtifactDraftHead,
  type AgentArtifactDraftHeadScope,
} from "../db/agent-artifact-repo.js"
import { readSelectedJobSourceDigestWithClient } from "./subagents/selected-job-artifact-context.js"
import { selectedJobArtifactCompletionGateWithWitness, type SelectedJobCompletionGraphWitness } from "./selected-job-completion-gate.js"
import { selectedJobArtifactFinalizationGuard } from "./selected-job-finalization-guard.js"
import { canonicalTaskGraphJson } from "./subagents/task-graph-snapshot.js"

const BLOCKED: Extract<TurnEngineCompletionGateResult, { ok: false }> = Object.freeze({
  ok: false,
  blocker: "selected_job_draft_review_required",
  feedback: "Complete and review the scheduled job draft before finishing.",
})

type BoundCandidate = Extract<LoadedScheduledDraftCandidateBinding, { status: "bound" }>
type AcceptedDraft = Readonly<{
  binding: BoundCandidate
  graphWitness: SelectedJobCompletionGraphWitness
}>

/** Reuses selected-job artifact gates for a server-bound scheduled candidate. */
export function createCanonicalScheduledDraftRuntime(input: Readonly<{
  pool: pg.Pool
  commandPort?: TaskGraphCommandPort
  lease: TurnLease
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  artifactRepository: ReturnType<typeof createAgentArtifactRepository>
  draftHeadReader?: (scope: AgentArtifactDraftHeadScope) => Promise<AgentArtifactDraftHead | null>
  sourceDigestLoader?: (userId: string, jobId: string) => Promise<string | null>
}>): Readonly<{
  clear(): void
  complete(): Promise<TurnEngineCompletionGateResult>
  finalize(client: PoolClient): Promise<TurnEngineCompletionGateResult>
}> {
  const scope: TaskGraphReadScope = {
    userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
    rootTaskId: input.root.id, parentTaskId: input.root.id,
    turnLeaseOwner: input.lease.ownerId, turnLeaseVersion: input.lease.leaseVersion,
    parentLeaseOwner: input.lease.ownerId, parentAttemptCount: input.root.attemptCount,
  }
  let accepted: AcceptedDraft | undefined
  const bindingCurrent = async (
    client: PoolClient,
    binding: BoundCandidate,
  ): Promise<boolean> => binding.graphRevision === await graphRevision(client, input.commandPort, scope)
    && await validateScheduledDraftCandidateWitness(client, scope, binding.snapshot, binding.graphRevision, binding.jobId, binding.witness)

  return {
    clear() { accepted = undefined },
    async complete() {
      accepted = undefined
      if (!input.commandPort?.readCurrentWithClient) return BLOCKED
      try {
        return await transaction(input.pool, async client => {
          const binding = await readScheduledDraftCandidateBinding(client, scope)
          if (binding.status === "absent") return { ok: true }
          if (!await bindingCurrent(client, binding)) return BLOCKED
          const result = await selectedJobArtifactCompletionGateWithWitness({
            commandPort: { readCurrent: async readScope => input.commandPort!.readCurrentWithClient!(client, readScope) },
            lease: input.lease, root: input.root, selectedJobId: binding.jobId,
            readCurrentDraftHead: input.draftHeadReader ?? (currentScope => input.artifactRepository.findCurrentDraftHead(currentScope)),
            readCurrentReviewReceipt: currentScope => input.artifactRepository.findReviewReceipt(currentScope),
            readCurrentSourceDigest: async () => input.sourceDigestLoader
              ? input.sourceDigestLoader(input.lease.userId, binding.jobId)
              : (await loadSelectedJobArtifactContext(client, input.lease.userId, binding.jobId)).preparation.sourceDigest,
          })
          if (!result.ok) return result
          accepted = { binding, graphWitness: result.witness }
          return { ok: true }
        })
      } catch {
        accepted = undefined
        return BLOCKED
      }
    },
    async finalize(client) {
      try {
        const binding = await readScheduledDraftCandidateBinding(client, scope)
        if (!accepted) return binding.status === "absent" ? { ok: true } : BLOCKED
        if (binding.status !== "bound" || binding.jobId !== accepted.binding.jobId
          || binding.graphRevision !== accepted.binding.graphRevision
          || canonicalTaskGraphJson(binding.witness) !== canonicalTaskGraphJson(accepted.binding.witness)
          || !await bindingCurrent(client, binding)) return BLOCKED
        return selectedJobArtifactFinalizationGuard({
          client, commandPort: input.commandPort, lease: input.lease, root: input.root,
          selectedJobId: accepted.binding.jobId, acceptedGraphWitness: accepted.graphWitness,
          readCurrentDraftHead: findCurrentDraftHeadWithClient,
          readCurrentSourceDigest: (queryClient, currentScope) => readSelectedJobSourceDigestWithClient(queryClient, currentScope.userId, currentScope.jobId),
          readCurrentReviewReceipt: findReviewReceiptWithClient,
        })
      } catch {
        return BLOCKED
      }
    },
  }
}

async function graphRevision(
  client: PoolClient,
  commandPort: TaskGraphCommandPort | undefined,
  scope: TaskGraphReadScope,
): Promise<number | undefined> {
  if (!commandPort?.readCurrentWithClient) return undefined
  return (await commandPort.readCurrentWithClient(client, scope)).revision
}
