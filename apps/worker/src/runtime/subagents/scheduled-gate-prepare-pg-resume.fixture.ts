import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnLease } from "../turns/lease.js"
import { createHash, randomUUID } from "node:crypto"
import { vi } from "vitest"
import type { Pool } from "pg"
import { claimTurnLease, releaseTurnLease } from "../turns/lease.js"
import { createPgRootTaskStore } from "./root-task-store.js"
import { createCanonicalExecutionProjection } from "../canonical-execution-projection.js"
import { drainAgentWakeups } from "../wakeup/consumer.js"
import { postScheduledPipelineContinuation, type ScheduledPipelineAnalyzeCheckpointProof } from "./scheduled-pipeline-handoff.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineOwner } from "./scheduled-automation-pipeline-bridge.js"
import type { ScheduledGatePrepareSeedFixture } from "./scheduled-gate-prepare-pg.fixture.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"

export const SCHEDULED_GATE_BASE_RESUME = { basics: { name: "Scheduled Fixture Candidate" }, sections: [] }
const CHECKPOINT_PATH = "@/lib/agent/scheduled-taskgraph-gate-checkpoint"
const DB_PATH = "@/lib/db"
const BROKER_PATH = "@/lib/agent/broker/store"

export async function digestScheduledAnalyzeCheckpoint(value: unknown): Promise<string> {
  const checkpoint = await import(CHECKPOINT_PATH) as unknown as {
    scheduledTaskGraphAnalyzeCheckpointDigest(value: unknown): string | null
  }
  const digest = checkpoint.scheduledTaskGraphAnalyzeCheckpointDigest(value)
  if (!digest) throw new Error("scheduled_gate_prepare_checkpoint_invalid")
  return digest
}

export type ScheduledGatePrepareOwner = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number
  turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number
}>

export type ScheduledGatePrepareResumePorts = Readonly<{
  answerQuestion(input: Readonly<{ waitId: string; expectedTurnId: string; expectedRevision: number; answer: string }>): Promise<{
    disposition: string; status: string; waitId: string; turnId: string; nextTurnRevision: number
  }>
  finishRoot(input: Readonly<{ lease: TurnLease; rootTaskId: string; waitId: string }>): Promise<void>
  finishExecution(input: Readonly<{ userId: string; sessionId: string; turnId: string }>): Promise<void>
  releaseTurn(lease: TurnLease): Promise<boolean>
  drainWakeups(): Promise<number>
  claimTurn(input: Readonly<{ turnId: string; sessionId: string; ownerId: string }>): Promise<TurnLease>
  ensureRoot(input: Readonly<{ lease: TurnLease; rootTaskId: string; allowedActions: readonly string[] }>): Promise<{
    id: string; status: string; leaseOwner: string | null
  }>
  startExecution(input: Readonly<{ userId: string; sessionId: string; turnId: string }>): Promise<void>
}>

export type ScheduledGatePrepareResumeResult = Readonly<{
  owner: ScheduledGatePrepareOwner
  turnLease: TurnLease
  turnExecutionOwner: TurnExecutionOwnerFence
}>

/** Resolves the real Prepare choice and returns the newly claimed Root owner. */
export async function resumeScheduledGatePrepareTurn(input: Readonly<{
  owner: ScheduledGatePrepareOwner
  turnLease: TurnLease
  waitId: string
  expectedTurnRevision: number
  answer: string
  allowedActions: readonly string[]
  ports: ScheduledGatePrepareResumePorts
}>): Promise<ScheduledGatePrepareResumeResult> {
  const { owner, turnLease, ports } = input
  if (input.waitId.trim().length === 0 || input.waitId.length > 256 || input.answer.trim().length === 0
    || input.expectedTurnRevision < 0 || turnLease.turnId !== owner.turnId || turnLease.sessionId !== owner.sessionId
    || turnLease.userId !== owner.userId || turnLease.ownerId !== owner.turnLeaseOwnerId
    || turnLease.leaseVersion !== owner.turnLeaseVersion || owner.rootAttemptCount < 1) {
    throw new Error("scheduled_prepare_resume_input_invalid")
  }
  const answered = await ports.answerQuestion({ waitId: input.waitId, expectedTurnId: owner.turnId,
    expectedRevision: input.expectedTurnRevision, answer: input.answer })
  if (answered.disposition !== "resolved" || answered.status !== "answered" || answered.waitId !== input.waitId
    || answered.turnId !== owner.turnId || answered.nextTurnRevision !== input.expectedTurnRevision + 1) {
    throw new Error("scheduled_prepare_answer_not_committed")
  }
  await ports.finishRoot({ lease: turnLease, rootTaskId: owner.rootTaskId, waitId: input.waitId })
  await ports.finishExecution({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId })
  if (!await ports.releaseTurn(turnLease)) throw new Error("scheduled_prepare_turn_release_failed")
  if (await ports.drainWakeups() < 1) throw new Error("scheduled_prepare_turn_wakeup_missing")
  const resumedLease = await ports.claimTurn({ turnId: owner.turnId, sessionId: owner.sessionId,
    ownerId: `${turnLease.ownerId}-resumed` })
  if (resumedLease.turnId !== owner.turnId || resumedLease.sessionId !== owner.sessionId
    || resumedLease.userId !== owner.userId || resumedLease.leaseVersion !== turnLease.leaseVersion + 1) {
    throw new Error("scheduled_prepare_turn_reclaim_invalid")
  }
  const root = await ports.ensureRoot({ lease: resumedLease, rootTaskId: owner.rootTaskId, allowedActions: input.allowedActions })
  if (root.id !== owner.rootTaskId || root.status !== "running" || root.leaseOwner !== resumedLease.ownerId) {
    throw new Error("scheduled_prepare_root_resume_invalid")
  }
  await ports.startExecution({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId })
  const resumedOwner: ScheduledGatePrepareOwner = { ...owner, turnLeaseOwnerId: resumedLease.ownerId,
    turnLeaseVersion: resumedLease.leaseVersion }
  return {
    owner: resumedOwner,
    turnLease: resumedLease,
    turnExecutionOwner: { kind: "turn", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId, ownerId: resumedLease.ownerId,
      leaseVersion: resumedLease.leaseVersion, leaseExpiresAt: resumedLease.leaseExpiresAt },
  }
}

export function graphScope(seed: ScheduledGatePrepareSeedFixture,
  owner: Pick<ScheduledGatePrepareOwner, "userId" | "sessionId" | "turnId" | "rootTaskId" | "rootAttemptCount" | "turnLeaseOwnerId" | "turnLeaseVersion">) {
  return { ...seed.graphScopeV1, turnLeaseOwner: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion,
    parentLeaseOwner: owner.turnLeaseOwnerId, parentAttemptCount: owner.rootAttemptCount }
}

export function scheduledGateRootActions(): string[] {
  return [...new Set([...TASK_GRAPH_TEMPLATES.scout.allowedActions, ...TASK_GRAPH_TEMPLATES.analyst.allowedActions,
    ...TASK_GRAPH_TEMPLATES.prepare.allowedActions])]
}

export function turnExecutionOwner(seed: ScheduledGatePrepareSeedFixture, lease: TurnLease): TurnExecutionOwnerFence {
  return { kind: "turn", userId: seed.ids.userId, sessionId: seed.ids.sessionId, turnId: seed.ids.turnId,
    taskId: seed.ids.rootTaskId, rootTaskId: seed.ids.rootTaskId, ownerId: lease.ownerId,
    leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt }
}

export async function resumePrepareChoice(pool: Pool, seed: ScheduledGatePrepareSeedFixture, input: Readonly<{
  owner: ScheduledGatePrepareOwner; attestation: ScheduledAutomationPipelineAttestation; executionOwner: ScheduledGatePrepareSeedFixture["executionOwner"]
  continuationKey: string; choiceWaitId: string; nextTurnRevision: number; answer: string; allowedActions: readonly string[]
}>): Promise<ScheduledGatePrepareResumeResult & Readonly<{ handoff: ScheduledPipelineAnalyzeCheckpointProof; claimToken: string }>> {
  const web = await import(DB_PATH) as unknown as { db: { $disconnect(): Promise<void> } }
  const broker = await import(BROKER_PATH) as unknown as {
    answerQuestion(db: unknown, value: { sessionId: string; userId: string; waitId: string; clientMessageId: string;
      expectedTurnId: string; expectedRevision: number; answer: string; now: Date }): Promise<{
        disposition: string; status: string; waitId: string; turnId: string; nextTurnRevision: number
      }>
  }
  try {
    const turnLease = seed.turnLeaseV1
    const rootStore = createPgRootTaskStore(pool as never)
    const executionProjection = createCanonicalExecutionProjection(pool as never)
    const resumed = await resumeScheduledGatePrepareTurn({ owner: input.owner, turnLease, waitId: input.choiceWaitId,
      expectedTurnRevision: input.nextTurnRevision, answer: input.answer, allowedActions: input.allowedActions,
      ports: {
        answerQuestion: async value => broker.answerQuestion(web.db, { sessionId: input.owner.sessionId, userId: input.owner.userId,
          waitId: value.waitId, clientMessageId: `scheduled-prepare-answer-${input.owner.turnId}`, expectedTurnId: value.expectedTurnId,
          expectedRevision: value.expectedRevision, answer: value.answer, now: new Date() }),
        finishRoot: async value => { await rootStore.finish({ lease: value.lease, rootTaskId: value.rootTaskId,
          result: { status: "waiting_for_user", stepCount: 1, toolCallCount: 0, waitId: value.waitId } }) },
        finishExecution: value => executionProjection.finish({ ...value, result: { status: "waiting_for_user" } }),
        releaseTurn: lease => releaseTurnLease(pool as never, lease, "waiting_for_user"),
        drainWakeups: () => drainAgentWakeups(pool as never, 10),
        claimTurn: value => claimTurnLease(pool as never, value),
        ensureRoot: async value => {
          const result = await rootStore.ensure({ lease: value.lease, goal: "Resume scheduled automation after the user's choice",
            allowedActions: value.allowedActions })
          return { id: result.id, status: result.status, leaseOwner: result.leaseOwner }
        },
        startExecution: value => executionProjection.start(value),
      } })
    const owner: ScheduledAutomationPipelineOwner = { ...input.owner, turnLeaseOwnerId: resumed.owner.turnLeaseOwnerId,
      turnLeaseVersion: resumed.owner.turnLeaseVersion }
    const handoff = await rebindClaimAndPost(pool, owner, input.attestation, input.executionOwner, input.continuationKey)
    if (handoff.status !== "analyze_checkpointed") throw new Error("scheduled_prepare_rebind_handoff_invalid")
    return { ...resumed, owner: resumed.owner, handoff: handoff.proof, claimToken: handoff.claimToken }
  } finally {
    await web.db.$disconnect()
  }
}

async function rebindClaimAndPost(pool: Pool, owner: ScheduledAutomationPipelineOwner,
  attestation: ScheduledAutomationPipelineAttestation, executionOwner: ScheduledGatePrepareSeedFixture["executionOwner"],
  continuationKey: string): Promise<{ status: "analyze_checkpointed"; proof: ScheduledPipelineAnalyzeCheckpointProof; claimToken: string }
  | { status: "blocked" }> {
  let claimToken = ""
  const oldUrl = process.env.AGENT_WEB_URL, oldSecret = process.env.AGENT_WORKER_SECRET
  process.env.AGENT_WEB_URL = "http://scheduled-gate-prepare.integration.invalid"
  process.env.AGENT_WORKER_SECRET = `scheduled-gate-prepare-secret-${randomUUID()}`
  const runPath = "@/lib/agent/run-service", routerPath = "@/lib/model-router", entitlementsPath = "@/lib/entitlements"
  try {
    vi.doMock(runPath, () => ({ runAgentPipeline: vi.fn(async (raw: unknown) => {
      const scheduled = (raw as { scheduledTaskGraph: { owner: ScheduledAutomationPipelineOwner; continuationKey: string; claimToken: string } }).scheduledTaskGraph
      claimToken = scheduled.claimToken
      const saved = await pool.query<{ state: unknown }>(`SELECT "state" FROM "agent_executions" WHERE "id"=$1`, [executionOwner.executionId])
      const digest = await digestScheduledAnalyzeCheckpoint(saved.rows[0]?.state)
      if (!digest || scheduled.owner.turnLeaseVersion !== owner.turnLeaseVersion) throw new Error("scheduled_prepare_rebind_state_invalid")
      return { status: "analyze_checkpointed", continuationKey: scheduled.continuationKey, checkpointDigest: digest,
        claimTokenDigest: `sha256:${createHash("sha256").update(scheduled.claimToken, "utf8").digest("hex")}`,
        executionId: executionOwner.executionId, executionAttemptCount: executionOwner.executionAttemptCount }
    }) }))
    vi.doMock(routerPath, () => ({ APPLYMATE_BACKING: "fixture", loadUserAiConfig: async () => ({ resolvedKey: "fixture-key", provider: "fixture", model: "scheduled-pipeline" }),
      resolveConfig: () => ({ resolvedKey: "fixture-key", provider: "fixture", model: "scheduled-pipeline" }) }))
    vi.doMock(entitlementsPath, () => ({ isFeatureAllowed: async () => true, hasEffectiveEntitlement: async () => true,
      resolveAiAccess: async () => "available" }))
    const route = await vi.importActual<{ POST(request: Request): Promise<Response> }>("@/app/api/internal/agent-runtime/scheduled-pipeline/route")
    const fetcher: typeof fetch = async (input, init) => route.POST(new Request(input, init))
    const result = await postScheduledPipelineContinuation({ owner, attestation }, new AbortController().signal, fetcher)
    return result.status === "analyze_checkpointed" && claimToken.length > 0 ? { ...result, claimToken } : { status: "blocked" }
  } finally {
    vi.doUnmock(runPath); vi.doUnmock(routerPath); vi.doUnmock(entitlementsPath); vi.resetModules()
    if (oldUrl === undefined) delete process.env.AGENT_WEB_URL; else process.env.AGENT_WEB_URL = oldUrl
    if (oldSecret === undefined) delete process.env.AGENT_WORKER_SECRET; else process.env.AGENT_WORKER_SECRET = oldSecret
  }
}
