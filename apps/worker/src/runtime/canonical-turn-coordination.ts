import type { StepContextSnapshot } from "./context/step-context-builder.js"
import type { TaskGraphCommandPort, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { NativeCoordinationRuntimeOptions } from "./tools/coordination-types.js"
import { nativeCoordinationReceipts, nativeReceiptsMatchGraph } from "./canonical-turn-native-graph-context.js"
import { mergeTaskGraphCurrentObservation } from "./canonical-turn-task-graph-context.js"

export type NativeGraphCompletionDecision = Readonly<{ ok: false; blocker: string; feedback: string }>

/** Shares root fencing, refresh and durable native-receipt requirements across one Turn. */
export function createCanonicalTurnCoordination(input: Readonly<{
  enabled: boolean
  commandPort?: TaskGraphCommandPort
  lease: TurnLease
}>): Readonly<{
  nativeOptions: NativeCoordinationRuntimeOptions
  bindRoot(root: Pick<SubagentTaskRecord, "id" | "attemptCount">): void
  refresh(snapshot: StepContextSnapshot): Promise<StepContextSnapshot>
  checkNativeGraphCompletion(): Promise<NativeGraphCompletionDecision | null>
}> {
  let root: Pick<SubagentTaskRecord, "id" | "attemptCount"> | undefined
  const receipts = new Map<string, ReturnType<typeof nativeCoordinationReceipts>[number]>()
  const nativeOptions: NativeCoordinationRuntimeOptions = {
    enabled: input.enabled,
    commandPort: input.commandPort,
    turnLeaseOwner: input.lease.ownerId,
    turnLeaseVersion: input.lease.leaseVersion,
    parentLeaseOwner: input.lease.ownerId,
    parentAttemptCount: () => root?.attemptCount,
  }
  function remember(snapshot: StepContextSnapshot): void {
    for (const receipt of nativeCoordinationReceipts(snapshot)) {
      const previous = receipts.get(receipt.operationId)
      if (previous && (previous.requestFingerprint !== receipt.requestFingerprint || previous.nodeKey !== receipt.nodeKey
        || previous.rootTaskId !== receipt.rootTaskId || previous.child.taskId !== receipt.child.taskId)) {
        throw new Error("native_coordination_receipt_conflict")
      }
      receipts.set(receipt.operationId, receipt)
    }
  }
  function readScope(): TaskGraphReadScope {
    if (!root || !input.commandPort) throw new Error("task_graph_runtime_dependencies_unavailable")
    return {
      userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
      rootTaskId: root.id, parentTaskId: root.id, turnLeaseOwner: input.lease.ownerId,
      turnLeaseVersion: input.lease.leaseVersion, parentLeaseOwner: input.lease.ownerId, parentAttemptCount: root.attemptCount,
    }
  }
  async function currentGraph() {
    if (!input.commandPort) throw new Error("task_graph_runtime_dependencies_unavailable")
    return input.commandPort.readCurrent(readScope())
  }
  return {
    nativeOptions,
    bindRoot(value) { root = value },
    async refresh(snapshot) {
      remember(snapshot)
      const state = await currentGraph()
      const required = [...receipts.values()]
      if (!root || !nativeReceiptsMatchGraph(required, state, root.id)) throw new Error("task_graph_native_coordination_missing")
      return mergeTaskGraphCurrentObservation(snapshot, state)
    },
    async checkNativeGraphCompletion() {
      if (receipts.size === 0) return null
      try {
        const state = await currentGraph()
        if (root && nativeReceiptsMatchGraph([...receipts.values()], state, root.id)) return null
      } catch { /* The durable receipt keeps the graph requirement fail-closed. */ }
      return {
        ok: false,
        blocker: "task_graph_verification_unverified",
        feedback: "Native coordination has no matching current TaskGraph operation; inspect TaskGraph before completing.",
      }
    },
  }
}
