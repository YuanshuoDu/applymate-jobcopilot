import type { Prisma } from "@prisma/client"
import type { ScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import { resolveScheduledTaskGraphRecoveryAdmission, type ScheduledTaskGraphRecoveryAdmissionCaller } from "./scheduled-taskgraph-recovery-admission"
import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"
import { matchingTurnSnapshot } from "./scheduled-taskgraph-pipeline-request"

type RecoveryCallsiteClient = Pick<Prisma.TransactionClient, "$queryRaw" | "agentExecution">
type RecoveryCallsiteOwner = Omit<ScheduledTaskGraphPipelineOwner, "executionId" | "executionAttemptCount">
export type ScheduledTaskGraphRecoveryCaller = "analyze_prepare" | "gate" | "execute" | "audit"
function isRecoveryCaller(caller: ScheduledTaskGraphRecoveryCaller): caller is ScheduledTaskGraphRecoveryAdmissionCaller {
  return caller === "analyze_prepare" || caller === "gate"
}

export async function scheduledTaskGraphGatePreflightSnapshot(input: {
  client: RecoveryCallsiteClient
  request?: Request
  owner: RecoveryCallsiteOwner
  turnInput: unknown
}): Promise<ScheduledAutomationSnapshot | null> {
  const scheduled = matchingTurnSnapshot(input.turnInput)
  if (scheduled) return scheduled
  if (!input.request) return null
  const execution = await input.client.agentExecution.findFirst({ where: { userId: input.owner.userId, sessionId: input.owner.sessionId },
    select: { id: true, attemptCount: true } })
  if (!execution || !Number.isSafeInteger(execution.attemptCount)) return null
  return scheduledTaskGraphRecoverySnapshot({ ...input, owner: { ...input.owner, executionId: execution.id,
    executionAttemptCount: execution.attemptCount }, caller: "gate" })
}

export async function scheduledTaskGraphRecoverySnapshot(input: {
  client: RecoveryCallsiteClient
  request?: Request
  owner: ScheduledTaskGraphPipelineOwner
  turnInput: unknown
  caller: ScheduledTaskGraphRecoveryCaller
}): Promise<ScheduledAutomationSnapshot | null> {
  const scheduled = matchingTurnSnapshot(input.turnInput)
  if (scheduled) return scheduled
  if (!input.request || !isRecoveryCaller(input.caller)) return null
  return (await resolveScheduledTaskGraphRecoveryAdmission({ client: input.client, request: input.request, owner: input.owner,
    caller: input.caller }))?.snapshot ?? null
}
