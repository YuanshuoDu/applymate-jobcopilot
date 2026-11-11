import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import { createPgInputClaimTransaction, type InputClaimTransaction } from "./context/input-claim-store.js"
import type { StepContextRequest } from "./context/step-context-builder.js"
import type { TurnLease } from "./turns/lease.js"
import { withRootTaskHistorySessionAuthorization } from "./context/root-task-history-session-memory.js"
import { withRootTaskHistoryObjectiveSnapshot, withRootTaskHistorySearchFootprintSnapshot } from "./context/root-task-history-objective-snapshot.js"
import { readRootTaskHistorySteerEvidence } from "./context/root-task-history-steer-evidence.js"
import { readRootTaskHistoryFence } from "./context/root-task-history-fence.js"
import { projectRootTaskHistory, type ValidatedRootTaskHistoryOutcome } from "./context/root-task-history.js"
import type { DirectRootTaskHistoryLoadInput, DirectRootTaskHistorySearchFootprintLoadInput } from "./context/root-task-history-direct-store.js"
import type { ContextSeedBlock, StepContext, StepContextSnapshot } from "./context/step-context-builder.js"
import { parseRootTaskHistoryChronologyXid8 } from "./context/root-task-history-chronology-witness.js"
import { canonicalJson } from "./context/context-snapshot-json.js"
import { rootTaskHistorySearchFootprintObservation, ROOT_TASK_HISTORY_SEARCH_FOOTPRINT_OBSERVATION_ID,
  type RootTaskHistorySearchFootprintContext } from "./context/root-task-history-search-footprint-context.js"

export type DirectRootTaskHistoryReader = Readonly<{
  load(input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]>
  loadWithClient?(client: pg.PoolClient, input: DirectRootTaskHistoryLoadInput): Promise<readonly ValidatedRootTaskHistoryOutcome[]>
  loadSearchFootprints?(input: DirectRootTaskHistorySearchFootprintLoadInput): Promise<RootTaskHistorySearchFootprintContext>
  loadSearchFootprintsWithClient?(client: pg.PoolClient, input: DirectRootTaskHistorySearchFootprintLoadInput): Promise<RootTaskHistorySearchFootprintContext>
}>

/** Adds only the independently projected footprint observation to an already built context. */
export function appendCanonicalRootTaskHistorySearchFootprints(input: Readonly<{
  context: StepContext; searchFootprints: RootTaskHistorySearchFootprintContext
}>): StepContext {
  const observation = rootTaskHistorySearchFootprintObservation(input.searchFootprints)
  const id = `observation:${ROOT_TASK_HISTORY_SEARCH_FOOTPRINT_OBSERVATION_ID}`
  const previousIndex = input.context.blocks.findIndex(block => block.id === id)
  const blocks = input.context.blocks.filter(block => block.id !== id)
  if (observation) {
    const block = { id, layer: "tool_observation" as const, role: "data" as const,
      trust: "external_untrusted" as const, source: "tool_or_subagent", content: observation.content as import("./context/step-context-builder.js").JsonValue }
    blocks.splice(previousIndex < 0 ? blocks.length : Math.min(previousIndex, blocks.length), 0, block)
  }
  const canonical = canonicalJson({ schemaVersion: input.context.schemaVersion, sessionId: input.context.sessionId,
    turnId: input.context.turnId, stepId: input.context.stepId, inputThroughSequence: input.context.inputThroughSequence.toString(),
    consumedInputIds: input.context.consumedInputIds, blocks })
  return { ...input.context, blocks, canonicalJson: canonical }
}

type RootHistoryTransactionalBuilder = Readonly<{
  buildInTransaction: (transaction: InputClaimTransaction, request: StepContextRequest) => Promise<StepContext>
}>

export function withoutCallerSearchFootprints(snapshot: StepContextSnapshot): StepContextSnapshot {
  return { ...snapshot, toolObservations: snapshot.toolObservations.filter(observation =>
    observation.id !== ROOT_TASK_HISTORY_SEARCH_FOOTPRINT_OBSERVATION_ID) }
}

async function replaceBuiltHistory(context: StepContext, snapshot: StepContextSnapshot): Promise<StepContext> {
  const history = snapshot.toolObservations.find(observation => observation.id === "root-task-history")
  const id = "observation:root-task-history", previousIndex = context.blocks.findIndex(block => block.id === id)
  const blocks = context.blocks.filter(block => block.id !== id)
  if (history) {
    const block = { id, layer: "tool_observation" as const, role: "data" as const,
      trust: "external_untrusted" as const, source: "tool_or_subagent", content: history.content as import("./context/step-context-builder.js").JsonValue }
    blocks.splice(previousIndex < 0 ? blocks.length : Math.min(previousIndex, blocks.length), 0, block)
  }
  const canonical = canonicalJson({ schemaVersion: context.schemaVersion, sessionId: context.sessionId,
    turnId: context.turnId, stepId: context.stepId, inputThroughSequence: context.inputThroughSequence.toString(),
    consumedInputIds: context.consumedInputIds, blocks })
  return { ...context, blocks, canonicalJson: canonical }
}

/** Builds Task History and searchFootprints from their separately authorized channels. */
export async function buildCanonicalRootTaskHistoryContext(input: Readonly<{
  pool: Pick<pg.Pool, "connect">; scope: TenantScope; lease: TurnLease; rootTaskId: string; rootAttemptCount: number
  reader: DirectRootTaskHistoryReader; base: RootHistoryTransactionalBuilder
  request: StepContextRequest; snapshot: StepContextSnapshot
  crossSessionRootTaskHistoryEnabled?: boolean; objectiveHistoryIndexEnabled?: boolean
}>): Promise<StepContext> {
  const now = input.request.now ?? new Date(), historyRequest: DirectRootTaskHistoryLoadInput = {
    lease: input.lease, rootTaskId: input.rootTaskId, rootAttemptCount: input.rootAttemptCount, stepId: input.request.stepId, now,
  }
  const client = await input.pool.connect()
  let committed = false
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    const result = await withRootTaskHistorySessionAuthorization(client, {
      scope: input.scope, lease: input.lease, rootTaskId: input.rootTaskId, rootAttemptCount: input.rootAttemptCount,
      stepId: input.request.stepId, environmentGateEnabled: input.crossSessionRootTaskHistoryEnabled === true,
    }, async (transactionClient, authorization, historyReadAllowed, searchFootprintReadAllowed?: boolean) => {
      const claimTransaction = createPgInputClaimTransaction(transactionClient, input.scope)
      const sameSessionOutcomes = await input.reader.loadWithClient!(transactionClient, historyRequest)
      const cleanSnapshot = withoutCallerSearchFootprints(input.snapshot)
      const sameSessionSnapshot = appendCanonicalRootTaskHistoryOutcomes({ snapshot: cleanSnapshot,
        sameSessionOutcomes, crossSessionRootTaskHistoryEnabled: false })
      let built = await input.base.buildInTransaction(claimTransaction, { ...input.request, snapshot: sameSessionSnapshot, taskId: input.rootTaskId })
      const steerEvidence = await readRootTaskHistorySteerEvidence(transactionClient, input.scope, {
        sessionId: input.request.sessionId, turnId: input.request.turnId, stepId: input.request.stepId,
        lease: { ownerId: input.lease.ownerId, leaseVersion: input.lease.leaseVersion, now },
      })
      const searchFootprintsAllowed = searchFootprintReadAllowed === true
      if ((!historyReadAllowed && !searchFootprintsAllowed) || steerEvidence.kind !== "no_accepted_steer") return built
      const crossRequest: DirectRootTaskHistoryLoadInput = { ...historyRequest, crossSessionRootTaskHistoryEnabled: true,
        ...(input.objectiveHistoryIndexEnabled === true ? { objectiveHistoryIndexEnabled: true } : {}) }
      const fence = await readRootTaskHistoryFence(transactionClient, crossRequest)
      if (!fence?.currentOrigin) return built
      if (historyReadAllowed) {
        const memory = await withRootTaskHistoryObjectiveSnapshot({ client: transactionClient, lease: input.lease,
          rootTaskId: input.rootTaskId, authorization, fence, acceptedInputRevision: built.inputThroughSequence, steerEvidence,
          loadOutcomes: async sameClient => (await input.reader.loadWithClient!(sameClient as pg.PoolClient, crossRequest))
            .filter(outcome => outcome.sourceSessionDiffers === true) })
        if (memory) built = await replaceBuiltHistory(built, appendCanonicalRootTaskHistoryOutcomes({ snapshot: sameSessionSnapshot,
          sameSessionOutcomes, crossSessionOutcomes: memory.outcomes, crossSessionRootTaskHistoryEnabled: true }))
      }
      if (searchFootprintsAllowed && input.reader.loadSearchFootprintsWithClient) {
        const footprintRequest: DirectRootTaskHistorySearchFootprintLoadInput = { ...historyRequest,
          searchFootprintReadAllowed: true,
          ...(input.objectiveHistoryIndexEnabled === true ? { objectiveHistoryIndexEnabled: true } : {}) }
        const memory = await withRootTaskHistorySearchFootprintSnapshot({ client: transactionClient, lease: input.lease,
          rootTaskId: input.rootTaskId, authorization, fence, acceptedInputRevision: built.inputThroughSequence, steerEvidence,
          searchFootprintReadAllowed: true,
          loadSearchFootprints: sameClient => input.reader.loadSearchFootprintsWithClient!(sameClient as pg.PoolClient, footprintRequest) })
        if (memory) built = appendCanonicalRootTaskHistorySearchFootprints({ context: built, searchFootprints: memory.searchFootprints })
      }
      return built
    })
    await client.query("COMMIT"); committed = true
    return result.workResult
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

/** Replaces any caller-provided reserved block with history read from the canonical owner-scoped source. */
export async function appendCanonicalRootTaskHistory(input: Readonly<{
  snapshot: StepContextSnapshot
  reader: DirectRootTaskHistoryReader
  request: DirectRootTaskHistoryLoadInput
}>): Promise<StepContextSnapshot> {
  const outcomes = await input.reader.load(input.request)
  const crossSessionEnabled = input.request.crossSessionRootTaskHistoryEnabled === true
  return appendCanonicalRootTaskHistoryOutcomes({ snapshot: input.snapshot,
    sameSessionOutcomes: crossSessionEnabled ? outcomes.filter(outcome => outcome.sourceSessionDiffers === false) : outcomes,
    crossSessionOutcomes: crossSessionEnabled ? outcomes.filter(outcome => outcome.sourceSessionDiffers === true) : [],
    crossSessionRootTaskHistoryEnabled: crossSessionEnabled })
}

/** Reprojects same-session and immutable cross-session outcomes together under the shared history bounds. */
export function appendCanonicalRootTaskHistoryOutcomes(input: Readonly<{
  snapshot: StepContextSnapshot
  sameSessionOutcomes: readonly ValidatedRootTaskHistoryOutcome[]
  crossSessionOutcomes?: readonly ValidatedRootTaskHistoryOutcome[]
  crossSessionRootTaskHistoryEnabled?: boolean
}>): StepContextSnapshot {
  const observations = input.snapshot.toolObservations.filter(item => item.id !== "root-task-history")
  const crossSessionEnabled = input.crossSessionRootTaskHistoryEnabled === true
  const cross = input.crossSessionOutcomes ?? []
  const hasVerifiedOrder = [...input.sameSessionOutcomes, ...cross].every(outcome =>
    parseRootTaskHistoryChronologyXid8(outcome.terminalXid8) !== undefined && typeof outcome.terminalWitnessEventId === "string"
      && outcome.terminalWitnessEventId.length > 0)
  const canComposeCrossSession = crossSessionEnabled && cross.length > 0 && hasVerifiedOrder
    && input.sameSessionOutcomes.every(outcome => outcome.sourceSessionDiffers === false)
    && cross.every(outcome => outcome.sourceSessionDiffers === true)
  const outcomes = canComposeCrossSession ? [...input.sameSessionOutcomes, ...cross] : input.sameSessionOutcomes
  const block: ContextSeedBlock | undefined = outcomes.length
    ? projectRootTaskHistory(outcomes, canComposeCrossSession)
    : undefined
  return block
    ? { ...input.snapshot, toolObservations: [...observations, block] }
    : { ...input.snapshot, toolObservations: observations }
}
