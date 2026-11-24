import type pg from "pg"
import type { PoolClient } from "pg"
import { findCurrentDraftHeadWithClient, findReviewReceiptWithClient } from "../db/agent-artifact-repo.js"
import { readSelectedJobSourceDigestWithClient } from "./subagents/selected-job-artifact-context.js"
import { readCurrentObjectiveTailorBinding } from "./subagents/objective-tailor-current-binding.js"
import type { ObjectiveTailorCandidateWitness } from "./subagents/objective-tailor-witness.js"
import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope } from "./subagents/task-graph-pg-state.js"
import { canonicalTaskGraphJson } from "./subagents/task-graph-snapshot.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import { selectedJobArtifactCompletionGateWithWitness, type SelectedJobCompletionGraphWitness } from "./selected-job-completion-gate.js"
import { selectedJobArtifactFinalizationGuard } from "./selected-job-finalization-guard.js"
import { verifyCanonicalObjectiveTailorWaveCompletion, type ObjectiveTailorWaveCompletionWitness } from "./canonical-objective-tailor-wave-completion.js"
import type { LoadedGraph } from "./subagents/task-graph-pg-state.js"

type Accepted = Readonly<{ status: "absent" }> | Readonly<{
  status: "bound"
  witness: ObjectiveTailorCandidateWitness
  writerTaskId: string
  reviewerTaskId: string
  graphWitness: SelectedJobCompletionGraphWitness
}> | Readonly<{ status: "wave"; witness: ObjectiveTailorWaveCompletionWitness }>
type Input = Readonly<{
  pool: Pick<pg.Pool, "connect">
  lease: TurnLease
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  commandPort: TaskGraphCommandPort | undefined
}>

const BLOCKED: Extract<TurnEngineCompletionGateResult, { ok: false }> = Object.freeze({
  ok: false, blocker: "selected_job_draft_review_required",
  feedback: "Complete and review the current Objective cover-letter pair before finishing.",
})

/** Root-only candidate and terminal fence for a persisted Objective Writer/Reviewer pair. */
export function createCanonicalObjectiveTailorRuntime(input: Input): Readonly<{
  complete(): Promise<TurnEngineCompletionGateResult>
  finalize(client: PoolClient): Promise<TurnEngineCompletionGateResult>
  clear(): void
}> {
  let accepted: Accepted | undefined
  const scope = (): TaskGraphReadScope => ({
    userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
    rootTaskId: input.root.id, parentTaskId: input.root.id, turnLeaseOwner: input.lease.ownerId,
    turnLeaseVersion: input.lease.leaseVersion, parentLeaseOwner: input.lease.ownerId,
    parentAttemptCount: input.root.attemptCount,
  })
  const identity = (read: TaskGraphReadScope) => ({ userId: read.userId, sessionId: read.sessionId, turnId: read.turnId,
    rootTaskId: read.rootTaskId, parentTaskId: read.parentTaskId })
  const matchesScope = (left: TaskGraphReadScope, right: TaskGraphReadScope) =>
    canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right)
  const graphReader = (graph: TaskGraphCurrentState): Pick<TaskGraphCommandPort, "readCurrent"> => ({
    readCurrent: async requested => {
      if (!matchesScope(requested, scope())) throw new Error("objective_tailor_graph_scope_mismatch")
      return graph
    },
  })

  async function withCandidateTransaction(): Promise<Accepted | undefined> {
    if (!input.commandPort) return undefined
    let client: PoolClient | undefined
    let committed = false
    try {
      const txClient = await input.pool.connect()
      client = txClient
      await txClient.query("BEGIN")
      await txClient.query("SELECT set_config($1, $2, true)", ["app.user_id", input.lease.userId])
      const readScope = scope()
      await lockTaskGraphScope(txClient, readScope, true)
      const loaded = await loadTaskGraph(txClient, identity(readScope), true)
      if (hasWaveMarker(loaded)) {
        const result = await verifyCanonicalObjectiveTailorWaveCompletion({ client: txClient, lease: input.lease,
          root: input.root, loaded, allowAbsent: false })
        if (result.status !== "ready") return undefined
        await txClient.query("COMMIT")
        committed = true
        return { status: "wave", witness: result.witness }
      }
      const binding = await readCurrentObjectiveTailorBinding(txClient, identity(readScope), loaded)
      if (binding.status === "invalid") return undefined
      if (binding.status === "absent") {
        await txClient.query("COMMIT")
        committed = true
        return { status: "absent" }
      }
      const graph = currentTaskGraph(loaded)
      const gate = await selectedJobArtifactCompletionGateWithWitness({
        commandPort: graphReader(graph), lease: input.lease, root: input.root,
        selectedJobId: binding.witness.candidate.jobId,
        readCurrentDraftHead: headScope => findCurrentDraftHeadWithClient(txClient, headScope),
        readCurrentSourceDigest: () => readSelectedJobSourceDigestWithClient(txClient, input.lease.userId, binding.witness.candidate.jobId),
        readCurrentReviewReceipt: reviewScope => findReviewReceiptWithClient(txClient, reviewScope),
      })
      if (!gate.ok) return undefined
      await txClient.query("COMMIT")
      committed = true
      return { status: "bound", witness: binding.witness, writerTaskId: binding.writerTaskId,
        reviewerTaskId: binding.reviewerTaskId, graphWitness: gate.witness }
    } catch {
      return undefined
    } finally {
      if (client) {
        if (!committed) await client.query("ROLLBACK").catch(() => undefined)
        client.release()
      }
    }
  }

  return {
    clear() { accepted = undefined },
    async complete() {
      accepted = undefined
      const next = await withCandidateTransaction()
      if (!next) return BLOCKED
      accepted = next
      return { ok: true }
    },
    async finalize(client) {
      const prior = accepted
      if (!prior || !input.commandPort) return BLOCKED
      try {
        const readScope = scope(), loaded = await loadTaskGraph(client, identity(readScope), true)
        if (prior.status === "wave") {
          if (!hasWaveMarker(loaded)) return BLOCKED
          const result = await verifyCanonicalObjectiveTailorWaveCompletion({ client, lease: input.lease,
            root: input.root, loaded, allowAbsent: false, acceptedWitness: prior.witness })
          return result.status === "ready" ? { ok: true } : BLOCKED
        }
        if (hasWaveMarker(loaded)) return BLOCKED
        const binding = await readCurrentObjectiveTailorBinding(client, identity(readScope), loaded)
        if (prior.status === "absent") return binding.status === "absent" ? { ok: true } : BLOCKED
        if (binding.status !== "bound" || binding.writerTaskId !== prior.writerTaskId
          || binding.reviewerTaskId !== prior.reviewerTaskId
          || canonicalTaskGraphJson(binding.witness) !== canonicalTaskGraphJson(prior.witness)) return BLOCKED
        const graph = currentTaskGraph(loaded)
        const terminalPort: TaskGraphCommandPort = { ...input.commandPort,
          readCurrentWithClient: async (sameClient, requested) => {
            if (sameClient !== client || !matchesScope(requested, readScope)) throw new Error("objective_tailor_terminal_scope_mismatch")
            return graph
          },
        }
        return await selectedJobArtifactFinalizationGuard({
          client, commandPort: terminalPort, lease: input.lease, root: input.root,
          selectedJobId: prior.witness.candidate.jobId, acceptedGraphWitness: prior.graphWitness,
          readCurrentDraftHead: findCurrentDraftHeadWithClient,
          readCurrentSourceDigest: (queryClient, source) => readSelectedJobSourceDigestWithClient(queryClient, source.userId, source.jobId),
          readCurrentReviewReceipt: findReviewReceiptWithClient,
        })
      } catch {
        return BLOCKED
      }
    },
  }
}

function hasWaveMarker(loaded: LoadedGraph): boolean {
  return hasOwn(loaded.snapshot, "objectiveTailor") || hasOwn(loaded.state, "objectiveTailor")
}

function hasOwn(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key)
}
