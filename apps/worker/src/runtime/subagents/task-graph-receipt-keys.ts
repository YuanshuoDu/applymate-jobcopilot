import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import {
  taskGraphItemId as sharedTaskGraphItemId,
  taskGraphLifecycleKey as sharedTaskGraphLifecycleKey,
  taskGraphProposalKey as sharedTaskGraphProposalKey,
  type TaskGraphFailedBranchReconciliationCodecs,
} from "@jobcopilot/agent-protocol/task-graph-failed-branch-reconciliation"

export const taskGraphProtocolCodecs: TaskGraphFailedBranchReconciliationCodecs = Object.freeze({
  sha256: value => createHash("sha256").update(value, "utf8").digest("hex"),
  utf8ByteLength: value => Buffer.byteLength(value, "utf8"),
})

export function taskGraphItemId(parentTaskId: string): string {
  return sharedTaskGraphItemId(parentTaskId, taskGraphProtocolCodecs)
}

export function taskGraphProposalKey(parentTaskId: string, expectedRevision: number): string {
  return sharedTaskGraphProposalKey(parentTaskId, expectedRevision, taskGraphProtocolCodecs)
}

export function taskGraphLifecycleKey(parentTaskId: string, nodeKey: string, attempt: number, type: string): string {
  return sharedTaskGraphLifecycleKey(parentTaskId, nodeKey, attempt, type, taskGraphProtocolCodecs)
}
