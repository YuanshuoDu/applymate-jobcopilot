import { createHash } from "node:crypto"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { Pool } from "pg"
import { attachScheduledPipelineCompletion } from "./scheduled-pipeline-completion.js"
import { createScheduledAutomationPrepareContinuation } from "./scheduled-automation-prepare-bridge.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeResult,
  ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import type { ScheduledPipelineAnalyzeCheckpointProof } from "./scheduled-pipeline-handoff.js"
import { createScheduledPipelineCandidateStore } from "./scheduled-pipeline-candidate-store.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import type { TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"
import { createScheduledTaskGraphContinuationContract } from "./scheduled-taskgraph-continuation-receipt.js"
import { scheduledPrepareChoiceWaitId } from "../turns/turn-question-contract.js"
import { createPgTurnQuestionStore } from "../turns/turn-question-store.js"
import { TurnEngine } from "../turns/turn-engine.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import type { TurnEngineOptions, TurnEngineResult } from "../turns/turn-engine-types.js"
import { createPgRootTaskStore } from "./root-task-store.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import type { ScheduledGatePrepareSeedFixture } from "./scheduled-gate-prepare-pg.fixture.js"
import { graphScope, scheduledGateRootActions, turnExecutionOwner } from "./scheduled-gate-prepare-pg-resume.fixture.js"

export const SCHEDULED_GATE_ROOT_CANDIDATE = "Scheduled Gate integration candidate."
const CANDIDATE_USAGE = { inputTokens: 37, outputTokens: 9, estimatedCostUsd: 0.018 }

export type ScheduledGatePrepareRootQuestion = Readonly<{
  stepId: string
  stepOrdinal: number
  candidateText: string
  choiceWaitId: string
  nextTurnRevision: number
}>

export function scheduledGatePrepareAnalyzeProof(input: Readonly<{
  continuationKey: string; checkpointDigest: string; claimToken: string; executionId: string; executionAttemptCount: number
}>): ScheduledPipelineAnalyzeCheckpointProof {
  return { status: "analyze_checkpointed", continuationKey: input.continuationKey,
    checkpointDigest: input.checkpointDigest,
    claimTokenDigest: `sha256:${createHash("sha256").update(input.claimToken, "utf8").digest("hex")}`,
    executionId: input.executionId, executionAttemptCount: input.executionAttemptCount }
}

/** Runs the initial Root answer through TurnEngine, candidate persistence and the real Prepare continuation. */
export async function runScheduledGatePrepareRootQuestion(input: Readonly<{
  pool: Pool
  seed: ScheduledGatePrepareSeedFixture
  owner: ScheduledAutomationPipelineBridgeScope
  attestation: ScheduledAutomationPipelineAttestation
  continuationKey: string
  checkpointDigest: string
  claimToken: string
  bridge(scope: ScheduledAutomationPipelineBridgeScope): Promise<ScheduledAutomationPipelineBridgeResult>
}>): Promise<ScheduledGatePrepareRootQuestion> {
  const { pool, seed, owner, attestation } = input
  if (owner.userId !== seed.ids.userId || owner.sessionId !== seed.ids.sessionId || owner.turnId !== seed.ids.turnId
    || owner.rootTaskId !== seed.ids.rootTaskId || owner.rootAttemptCount !== seed.ownerV1.rootAttemptCount
    || owner.turnLeaseOwnerId !== seed.turnLeaseV1.ownerId || owner.turnLeaseVersion !== seed.turnLeaseV1.leaseVersion
    || attestation.owner.userId !== owner.userId || attestation.owner.sessionId !== owner.sessionId
    || attestation.owner.turnId !== owner.turnId || attestation.owner.rootTaskId !== owner.rootTaskId
    || attestation.owner.rootAttemptCount !== owner.rootAttemptCount) throw new Error("scheduled_gate_prepare_root_owner_invalid")

  const lease = seed.turnLeaseV1, executionOwner = turnExecutionOwner(seed, lease)
  const rootStore = createPgRootTaskStore(pool as never)
  const root = await rootStore.ensure({ lease, goal: "Prepare the verified scheduled Analyze checkpoint",
    allowedActions: scheduledGateRootActions() })
  if (root.id !== seed.ids.rootTaskId || root.status !== "running" || root.leaseOwner !== lease.ownerId) {
    throw new Error("scheduled_gate_prepare_root_not_owned")
  }

  const candidateStore = createScheduledPipelineCandidateStore(pool as never, createPgTurnEngineStore(pool as never))
  const command = createPgTaskGraphCommandPort(pool as never), waitPort = createPgDurableWaitPort(pool as never)
  const prepare = createScheduledAutomationPrepareContinuation({ commandPort: command, waitPort })
  const handoffProof = scheduledGatePrepareAnalyzeProof({ continuationKey: input.continuationKey,
    checkpointDigest: input.checkpointDigest, claimToken: input.claimToken, executionId: seed.executionOwner.executionId,
    executionAttemptCount: seed.executionOwner.executionAttemptCount })
  let expectedWaitId: string | undefined, expectedReceipt: unknown, finalStep: { id: string; ordinal: number } | undefined
  const continueAfterAnalyze: NonNullable<Parameters<typeof attachScheduledPipelineCompletion>[0]["continueAfterAnalyze"]> = async continuation => {
    const scope = { ...graphScope(seed, continuation.owner), stepId: continuation.recoveryStepId }
    const prepareInput: TaskGraphScheduledPrepareInput = { scope, executionOwner: seed.executionOwner,
      handoff: continuation.proof, attestation: continuation.attestation,
      proposal: { expectedRevision: continuation.attestation.graphRevision, nodes: [{ key: "prepare", templateId: "prepare",
        goal: "Prepare application materials using the persisted scheduled Analyze checkpoint.", successCriteria: [
          "Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
          "Persist immutable owner-fenced material references and return no resume or letter bodies.",
        ], dependsOn: ["scheduled-analyst"] }] } }
    const contract = createScheduledTaskGraphContinuationContract(prepareInput)
    const waitId = contract ? scheduledPrepareChoiceWaitId({ receipt: contract.receipt,
      finalStepId: continuation.finalStepId, finalStepOrdinal: continuation.finalStepOrdinal }) : null
    if (!contract || !waitId) throw new Error("scheduled_gate_prepare_choice_contract_invalid")
    const result = await prepare(continuation)
    if (result.status !== "waiting_for_choice" || result.waitId !== waitId) throw new Error("scheduled_gate_prepare_choice_not_waiting")
    expectedWaitId = waitId; expectedReceipt = contract.receipt
    finalStep = { id: continuation.finalStepId, ordinal: continuation.finalStepOrdinal }
    return result
  }
  const fetcher: typeof fetch = async (_request, init) => {
    if (init?.method !== "POST" || typeof init.body !== "string") throw new Error("scheduled_gate_prepare_handoff_request_invalid")
    const body = record(JSON.parse(init.body))
    if (!body || body.action !== undefined || Object.hasOwn(body, "prepareProof")
      || !sameOwner(body.owner, owner) || !sameAttestation(body.attestation, attestation)) {
      throw new Error("scheduled_gate_prepare_handoff_scope_invalid")
    }
    return new Response(JSON.stringify(handoffProof), { status: 200, headers: { "content-type": "application/json" } })
  }
  const baseGate: NonNullable<TurnEngineOptions["completionGate"]> = async () => ({ ok: true })
  const completionGate = attachScheduledPipelineCompletion({ gate: baseGate, owner, bridge: input.bridge,
    continueAfterAnalyze, fetcher, stageCandidate: candidate => candidateStore.stage(candidate),
    onWebAccepted() {}, rootAttemptCount: owner.rootAttemptCount })
  if (!completionGate) throw new Error("scheduled_gate_prepare_completion_unavailable")
  const profile: ModelAdapter["profile"] = { provider: "fixture", model: "scheduled-gate-root-question", nativeTools: true,
    structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false,
    supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false,
    supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null,
    maxOutputTokens: 128, costClass: "low" }
  const model: ModelAdapter = { id: "scheduled-gate-root-question", profile, async *stream() {
    yield { type: "usage", ...CANDIDATE_USAGE, provider: "fixture", model: "scheduled-gate-root-question" }
    yield { type: "text_delta", text: SCHEDULED_GATE_ROOT_CANDIDATE }
    yield { type: "completed", finishReason: "stop" }
  } }
  const result: TurnEngineResult = await new TurnEngine({ lease, rootTaskId: seed.ids.rootTaskId, taskId: seed.ids.rootTaskId,
    scope: { userId: seed.ids.userId }, goal: "Prepare the verified scheduled Analyze checkpoint",
    snapshot: { system: [], profile: [], steerHistory: [], toolObservations: [],
      businessRefs: seed.selectedJobIds.map(id => ({ id, kind: "job" as const, ownerId: seed.ids.userId })) },
    contextBuilder: { async build(request) { return { schemaVersion: "agent-harness.v2", sessionId: request.sessionId,
      turnId: request.turnId, stepId: request.stepId, inputThroughSequence: 0n, consumedInputIds: [], blocks: [], canonicalJson: "{}" } } },
    store: createPgTurnEngineStore(pool as never), model, tools: [], executeTool: async ({ call }) => ({ id: call.id,
      toolName: call.toolName, toolVersion: call.toolVersion, status: "completed", errorCode: null }), completionGate,
  }).run()
  if (result.status !== "waiting_for_user" || result.waitId !== expectedWaitId || !finalStep) {
    throw new Error("scheduled_gate_prepare_root_question_not_persisted")
  }
  const question = await createPgTurnQuestionStore(pool as never).readScheduledPrepareChoice({ owner: executionOwner,
    now: new Date(), receipt: expectedReceipt })
  if (question.status !== "waiting" || question.waitId !== result.waitId) throw new Error("scheduled_gate_prepare_choice_witness_missing")
  const row = (await pool.query<{ revision: number | string; status: string; finishReason: string | null; ordinal: number | string }>(
    `SELECT turn."revision", turn."status", step."finishReason", step."ordinal" FROM "agent_turns" AS turn
      JOIN "agent_steps" AS step ON step."turnId"=turn."id" AND step."sessionId"=turn."sessionId"
      WHERE turn."id"=$1 AND turn."sessionId"=$2 AND step."id"=$3 AND step."taskId"=$4 AND step."status"='waiting_for_user'`,
    [seed.ids.turnId, seed.ids.sessionId, finalStep.id, seed.ids.rootTaskId])).rows[0]
  if (!row || row.status !== "waiting_for_user" || row.finishReason !== "stop" || Number(row.ordinal) !== finalStep.ordinal) {
    throw new Error("scheduled_gate_prepare_root_question_step_invalid")
  }
  return { stepId: finalStep.id, stepOrdinal: finalStep.ordinal, candidateText: SCHEDULED_GATE_ROOT_CANDIDATE,
    choiceWaitId: question.waitId, nextTurnRevision: Number(row.revision) }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function sameOwner(value: unknown, expected: ScheduledAutomationPipelineBridgeScope): boolean {
  const owner = record(value)
  return !!owner && owner.userId === expected.userId && owner.sessionId === expected.sessionId && owner.turnId === expected.turnId
    && owner.rootTaskId === expected.rootTaskId && owner.rootAttemptCount === expected.rootAttemptCount
    && owner.turnLeaseOwnerId === expected.turnLeaseOwnerId && owner.turnLeaseVersion === expected.turnLeaseVersion
}
function sameAttestation(value: unknown, expected: ScheduledAutomationPipelineAttestation): boolean {
  const actual = record(value), owner = record(actual?.owner), analyst = record(actual?.analyst)
  const expectedAnalyst = record(expected.analyst)
  return !!actual && !!owner && !!analyst && !!expectedAnalyst && sameOwner(owner, expected.owner)
    && actual.schemaVersion === expected.schemaVersion && actual.graphRevision === expected.graphRevision
    && actual.snapshotDigest === expected.snapshotDigest && actual.evidenceDigest === expected.evidenceDigest
    && analyst.taskId === expectedAnalyst.taskId
}
