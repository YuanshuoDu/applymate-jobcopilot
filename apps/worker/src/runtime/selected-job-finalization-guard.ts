import type { PoolClient } from "pg"
import type {
  AgentArtifactDraftHead, AgentArtifactDraftHeadScope, AgentArtifactReviewReceipt,
  AgentArtifactReviewReceiptScope,
} from "../db/agent-artifact-repo.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState } from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import {
  selectedJobArtifactCompletionGate, type SelectedJobCompletionGraphWitness,
} from "./selected-job-completion-gate.js"

export type SelectedJobSourceDigestScope = Readonly<{ userId: string; sessionId: string; jobId: string }>

/** Dependencies must read through this client so one terminal transaction observes one atomic scope. */
export type SelectedJobArtifactFinalizationGuardInput = Readonly<{
  client: PoolClient
  commandPort: TaskGraphCommandPort | undefined
  lease: TurnLease
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  selectedJobId: string | undefined
  acceptedGraphWitness: SelectedJobCompletionGraphWitness | undefined
  readCurrentDraftHead: ((client: PoolClient, scope: AgentArtifactDraftHeadScope) => Promise<AgentArtifactDraftHead | null>) | undefined
  readCurrentSourceDigest: ((client: PoolClient, scope: SelectedJobSourceDigestScope) => Promise<string | null>) | undefined
  readCurrentReviewReceipt: ((client: PoolClient, scope: AgentArtifactReviewReceiptScope) => Promise<AgentArtifactReviewReceipt | null>) | undefined
}>

export type SelectedJobArtifactFinalizationGuard = (
  input: SelectedJobArtifactFinalizationGuardInput,
) => Promise<TurnEngineCompletionGateResult>

function canonicalJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, child: unknown) => child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : child)
  } catch { return undefined }
}

function graphMatchesWitness(current: TaskGraphCurrentState, witness: SelectedJobCompletionGraphWitness): boolean {
  if (!Number.isSafeInteger(witness.revision) || current.revision !== witness.revision
    || !Array.isArray(witness.nodes) || current.nodes.length !== witness.nodes.length) return false
  const projection = (nodes: SelectedJobCompletionGraphWitness["nodes"]) => nodes.map(node => ({
    key: node.key, taskId: node.taskId, templateId: node.templateId, status: node.status,
    dependsOn: node.dependsOn, resultProjection: node.resultProjection ?? null,
  }))
  const currentJson = canonicalJson(projection(current.nodes))
  return currentJson !== undefined && currentJson === canonicalJson(projection(witness.nodes))
}

/** Revalidates the successful gate's graph witness and persisted evidence inside the caller's terminal transaction. */
export const selectedJobArtifactFinalizationGuard: SelectedJobArtifactFinalizationGuard = async input => {
  const commandPort = input.commandPort
  const acceptedGraphWitness = input.acceptedGraphWitness
  const selectedJobId = input.selectedJobId
  const transactionCommandPort: Pick<TaskGraphCommandPort, "readCurrent"> | undefined =
    commandPort && acceptedGraphWitness ? {
      readCurrent: async scope => {
        if (!commandPort.readCurrentWithClient) throw new Error("transaction_graph_reader_unavailable")
        const current = await commandPort.readCurrentWithClient(input.client, scope)
        if (!graphMatchesWitness(current, acceptedGraphWitness)) throw new Error("task_graph_completion_witness_changed")
        return current
      },
    } : undefined
  const readDraftHead = input.readCurrentDraftHead
  const readSourceDigest = input.readCurrentSourceDigest
  const readReviewReceipt = input.readCurrentReviewReceipt
  return selectedJobArtifactCompletionGate({
    commandPort: transactionCommandPort,
    lease: input.lease,
    root: input.root,
    selectedJobId,
    readCurrentDraftHead: readDraftHead ? scope => readDraftHead(input.client, scope) : undefined,
    readCurrentSourceDigest: readSourceDigest
      && selectedJobId
      ? () => readSourceDigest(input.client, { userId: input.lease.userId, sessionId: input.lease.sessionId, jobId: selectedJobId })
      : undefined,
    readCurrentReviewReceipt: readReviewReceipt ? scope => readReviewReceipt(input.client, scope) : undefined,
  })
}
