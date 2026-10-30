import { toRepositoryJson } from "./turn-engine-types.js"
import { childWaitClaimEventKey, isExactChildWaitInput, type ChildWaitClaimRecovery, type ChildWaitOrphanRecovery } from "../subagents/child-durable-wait-replay.js"
import { persistChildWaitClaimRecovery, TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-options.js"

type Recovery = ChildWaitClaimRecovery | ChildWaitOrphanRecovery
type Observation = { readonly id: string; readonly content: ReturnType<typeof toRepositoryJson> }

function assertCurrentOwner(options: TurnExecutionOptions, recovery: Recovery): void {
  const owner = options.identity, expected = recovery.owner
  if (owner.kind !== "task" || owner.taskId !== expected.id || owner.userId !== expected.userId
    || owner.sessionId !== expected.sessionId || owner.turnId !== expected.turnId || owner.rootTaskId !== expected.rootTaskId
    || owner.ownerId !== expected.ownerId || owner.attemptCount !== expected.attemptCount
    || recovery.call.name !== "wait_subagents" || !recovery.call.id.trim()
    || recovery.sourceWaitCallId.trim().length === 0 || recovery.stepId.trim().length === 0
    || !Number.isSafeInteger(recovery.stepOrdinal) || recovery.stepOrdinal < 0
    || !isExactChildWaitInput(recovery.call.arguments, recovery.sourceInput)) throw new Error("child_wait_claim_recovery_owner_mismatch")
  if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("child_wait_claim_recovery_interrupted")
}

async function closeRecoveredStep(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, recovery: Recovery, now: () => Date): Promise<void> {
  const owner = options.identity
  if (recovery.stepStatus === "streaming") await options.store.updateStep({ identity: owner, stepId: recovery.stepId, status: "completed",
    finishReason: null, errorCode: null, inputTokens: recovery.modelUsage.inputTokens, outputTokens: recovery.modelUsage.outputTokens,
    estimatedCostUsd: recovery.modelUsage.estimatedCostUsd, now: now() })
  await writer.append("step.completed", recovery.stepId, null,
    { stepId: recovery.stepId, status: "completed", toolCallCount: 1, taskId: owner.taskId }, `step-completed:${recovery.stepId}`)
}

async function finishRecovery(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, recovery: ChildWaitClaimRecovery, now: () => Date): Promise<Observation> {
  assertCurrentOwner(options, recovery)
  const result = await persistChildWaitClaimRecovery(options, writer, recovery, now)
  await closeRecoveredStep(options, writer, recovery, now)
  return { id: `tool-result:${result.id}`, content: toRepositoryJson({ toolCallId: result.id, toolName: result.toolName,
    input: recovery.call.arguments, status: result.status, output: result.output ?? null, errorCode: result.errorCode }) }
}

export async function recoverChildWaitClaim(
  options: TurnExecutionOptions, writer: TurnExecutionEventWriter, recovery: ChildWaitClaimRecovery, now: () => Date,
): Promise<Observation> {
  return finishRecovery(options, writer, recovery, now)
}

export async function recoverChildWaitOrphan(
  options: TurnExecutionOptions, writer: TurnExecutionEventWriter, recovery: ChildWaitOrphanRecovery, now: () => Date,
): Promise<Observation> {
  assertCurrentOwner(options, recovery)
  if (recovery.stepStatus !== "streaming" || recovery.callItem.status !== "started" || recovery.callItem.revision !== 0) {
    throw new Error("child_resume_wait_tool_call_conflict")
  }
  writer.seedCausationId(recovery.callStartedEventId)
  const claimEventId = await writer.append("tool_call.started", recovery.call.id, recovery.callItem.id,
    { toolCallId: recovery.call.id, toolName: "wait_subagents", taskId: options.identity.taskId },
    childWaitClaimEventKey(recovery.owner.attemptCount, recovery.stepId))
  return finishRecovery(options, writer, { ...recovery, claimEventId }, now)
}
