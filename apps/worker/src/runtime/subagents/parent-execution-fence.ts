import { inheritSubagentPolicy, SubagentLeaseError, type AtomicSubagentSpawnResult, type SubagentLease,
  type SubagentPolicy, type SubagentStore, type SubagentTaskSpec } from "./types.js"
import { policyFromTask } from "./manager-task-scope.js"

export type SubagentParentExecutionFence = Readonly<{
  id: string
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  ownerId: string
  attemptCount: number
}>

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function lost(message: string): never {
  throw new SubagentLeaseError("lost", message)
}

export function assertSpawnSpecMatchesParentFence(
  spec: Pick<SubagentTaskSpec, "userId" | "sessionId" | "turnId" | "parentTaskId">,
  fence: SubagentParentExecutionFence,
): void {
  if (spec.userId !== fence.userId || spec.sessionId !== fence.sessionId
    || spec.turnId !== fence.turnId || spec.parentTaskId !== fence.id) {
    lost("Parent execution lease scope does not match the requested child")
  }
}

export function captureSubagentParentExecutionFence(
  spec: Pick<SubagentTaskSpec, "userId" | "sessionId" | "turnId" | "parentTaskId">,
  lease: SubagentLease,
): SubagentParentExecutionFence {
  if (lease.signal?.aborted) lost("Parent execution lease is aborted")
  if (lease.status !== "running" || !isNonEmpty(lease.id) || !isNonEmpty(lease.userId)
    || !isNonEmpty(lease.sessionId) || !isNonEmpty(lease.turnId) || !isNonEmpty(lease.rootTaskId)
    || !isNonEmpty(lease.ownerId) || lease.leaseOwner !== lease.ownerId
    || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1) {
    lost("Parent execution lease is not current")
  }
  const fence: SubagentParentExecutionFence = Object.freeze({
    id: lease.id,
    userId: lease.userId,
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    rootTaskId: lease.rootTaskId,
    ownerId: lease.ownerId,
    attemptCount: lease.attemptCount,
  })
  assertSpawnSpecMatchesParentFence(spec, fence)
  return fence
}

export function clampNestedSubagentPolicy(policy: SubagentPolicy): SubagentPolicy {
  return { ...policy, maxDepth: Math.min(policy.maxDepth, 2), maxFanOut: Math.min(policy.maxFanOut, 2) }
}

export async function spawnSubagentFromLease(
  store: SubagentStore,
  spec: SubagentTaskSpec,
  spawnIdempotencyKey: string,
  parentLease: SubagentLease,
): Promise<AtomicSubagentSpawnResult & { atomic: true }> {
  const parentExecutionFence = captureSubagentParentExecutionFence(spec, parentLease)
  const createWithSpawnFromLease = store.createWithSpawnFromLease
  if (!createWithSpawnFromLease) throw new SubagentLeaseError("not_available", "Lease-fenced subagent spawn is unavailable")
  const policy = clampNestedSubagentPolicy(inheritSubagentPolicy(policyFromTask(parentLease), spec.policy))
  const result = await createWithSpawnFromLease.call(store, { ...spec, policy, spawnIdempotencyKey, parentExecutionFence })
  return { ...result, atomic: true }
}
