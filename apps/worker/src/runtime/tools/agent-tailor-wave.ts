import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { TaskGraphExecutionScope } from "../subagents/task-graph-command-port.js"
import { objectiveTailorCorrectionNodeKeys } from "../subagents/objective-tailor-correction-witness.js"
import { parseObjectiveTailorWaveCandidateRefs } from "../subagents/objective-tailor-wave-witness.js"
import { taskGraphExecutionScope, type ReconciliationFenceOptions } from "./steering-reconciliation.js"
import { ToolExecutionError, type RuntimeToolDefinition } from "./types.js"

type TailorWaveCommandInput = Readonly<{
  scope: TaskGraphExecutionScope
  expectedRevision: number
  candidateRefs: readonly string[]
}>
type TailorWaveCommandPort = Readonly<{
  appendObjectiveTailorWave?: (input: TailorWaveCommandInput) => Promise<unknown>
  appendObjectiveTailorCorrection?: (input: Readonly<{ scope: TaskGraphExecutionScope; expectedRevision: number; correctionSlotId: string }>) => Promise<unknown>
}>
type TailorWaveInput = Readonly<{ expectedRevision: number; candidateRefs: readonly string[] }>
type TailorCorrectionInput = Readonly<{ expectedRevision: number; correctionSlotId: string }>
type TailorInput = TailorWaveInput | TailorCorrectionInput
type SafeReceiptNode = Readonly<{ key: string; taskId: string; status: "queued" | "waiting" }>
type SafeReceipt = Readonly<{
  status: "accepted" | "duplicate"
  revision: number
  nodes: readonly SafeReceiptNode[]
  readyTaskIds: readonly string[]
}>

const MAX_REVISION = 2_147_483_646
const Id = Type.String({ minLength: 1, maxLength: 256 })
const CandidateRef = Type.String({ minLength: 69, maxLength: 69, pattern: "^otc2_[a-f0-9]{64}$" })
const ExpectedRevision = Type.Integer({ minimum: 1, maximum: MAX_REVISION - 1 })
const CandidateRefs = Type.Array(CandidateRef, { minItems: 1, maxItems: 4, uniqueItems: true })
const CorrectionSlotId = Type.String({ minLength: 8, maxLength: 8, pattern: "^tailor-[1-8]$" })
const Input = Type.Unsafe<TailorInput>({
  ...Type.Object({
    expectedRevision: ExpectedRevision,
    candidateRefs: Type.Optional(CandidateRefs),
    correctionSlotId: Type.Optional(CorrectionSlotId),
  }, { additionalProperties: false }),
  oneOf: [
    Type.Object({ expectedRevision: ExpectedRevision, candidateRefs: CandidateRefs }, { additionalProperties: false }),
    Type.Object({ expectedRevision: ExpectedRevision, correctionSlotId: CorrectionSlotId }, { additionalProperties: false }),
  ],
})
const Output = Type.Object({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  revision: Type.Integer({ minimum: 0, maximum: MAX_REVISION }),
  nodes: Type.Array(Type.Object({ key: Id, taskId: Id,
    status: Type.Union([Type.Literal("queued"), Type.Literal("waiting")]) }, { additionalProperties: false }), { minItems: 2, maxItems: 8 }),
  readyTaskIds: Type.Array(Id, { maxItems: 8 }),
}, { additionalProperties: false })

const DESCRIPTION = "Use the current server catalog after the typed Scout/Analyst source graph is terminal and each candidate is verified. Append one to four exact otc2 candidate references per wave; the server binds each Job and Writer/Reviewer pair. After agent.wait, a completed Reviewer result with reviewStatus needs_revision maps to its stable slotId in objectiveTailorWave.slots; request that one correction with correctionSlotId and the whole current graph revision. The server re-proves the exact current source and receipt. After either operation, wait on the exact returned child task IDs, at most eight targets and 30 seconds per call. A wait timeout is not completion. Do not claim a slot ready without completed Writer/Reviewer proof. Never provide Job IDs, source evidence, templates, artifact refs, receipts, or approvals."

/** A separately gated v2 wrapper; registration remains owned by canonical runtime wiring. */
export function createAgentTailorWaveTool(
  commandPort: TailorWaveCommandPort | undefined,
  options: ReconciliationFenceOptions,
): RuntimeToolDefinition {
  return {
    schemaVersion, name: "agent.tailor", version: "2", description: DESCRIPTION,
    capabilities: ["coordination"], inputSchema: Input, outputSchema: Output,
    risk: "internal_write", domain: "coordination", idempotency: "idempotent", timeoutMs: 30_000,
    requiredCapabilities: ["coordination", "canManageChildren"],
    async execute(context, value) {
      if (context.actorRole !== "orchestrator" || !context.taskId || context.taskId !== context.rootTaskId
        || !context.capabilities.includes("coordination") || !context.capabilities.includes("canManageChildren")) {
        throw new ToolExecutionError("objective_tailor_root_only", "Only the active Objective root can append a tailoring wave")
      }
      if (typeof context.remainingTurnSteps !== "number" || !Number.isSafeInteger(context.remainingTurnSteps)
        || context.remainingTurnSteps < 2) {
        throw new ToolExecutionError("task_graph_continuation_budget_required", "The Turn needs two remaining steps to supervise the tailoring wave")
      }
      const input = parseInput(value)
      if (!input) throw new ToolExecutionError("objective_tailor_wave_input_invalid", "Provide the current graph revision and either candidate references or one correction slot")
      const scope = taskGraphExecutionScope(context, options)
      let result: unknown
      try {
        if ("candidateRefs" in input) {
          const append = commandPort?.appendObjectiveTailorWave
          if (typeof append !== "function") throw new ToolExecutionError("objective_tailor_wave_unavailable", "Objective tailoring waves are unavailable for this Turn")
          result = await append.call(commandPort, { scope, expectedRevision: input.expectedRevision, candidateRefs: input.candidateRefs })
        } else {
          const append = commandPort?.appendObjectiveTailorCorrection
          if (typeof append !== "function") throw new ToolExecutionError("objective_tailor_correction_unavailable", "Objective tailoring corrections are unavailable for this Turn")
          result = await append.call(commandPort, { scope, expectedRevision: input.expectedRevision, correctionSlotId: input.correctionSlotId })
        }
      } catch (error: unknown) {
        throw commandFailure(error)
      }
      const receipt = projectReceipt(result, input.expectedRevision, "candidateRefs" in input ? input.candidateRefs.length : 1,
        "correctionSlotId" in input ? input.correctionSlotId : undefined)
      if (!receipt) throw new ToolExecutionError("objective_tailor_wave_receipt_invalid", "The tailoring wave receipt was invalid")
      return receipt
    },
  }
}

function parseInput(value: unknown): TailorInput | undefined {
  const input = plainRecord(value)
  if (!input || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1
    || Number(input.expectedRevision) >= MAX_REVISION) return undefined
  const keys = Object.keys(input).sort().join(",")
  if (keys === "candidateRefs,expectedRevision") {
    let candidateRefs: readonly string[] | undefined
    try { candidateRefs = parseObjectiveTailorWaveCandidateRefs(input.candidateRefs) } catch { return undefined }
    return candidateRefs ? { expectedRevision: Number(input.expectedRevision), candidateRefs } : undefined
  }
  if (keys === "correctionSlotId,expectedRevision" && typeof input.correctionSlotId === "string"
    && objectiveTailorCorrectionNodeKeys(input.correctionSlotId)) {
    return { expectedRevision: Number(input.expectedRevision), correctionSlotId: input.correctionSlotId }
  }
  return undefined
}

function projectReceipt(value: unknown, expectedRevision: number, pairCount: number, correctionSlotId?: string): SafeReceipt | undefined {
  const row = plainRecord(value)
  if (!row || (row.status !== "accepted" && row.status !== "duplicate")
    || !Number.isSafeInteger(row.revision) || Number(row.revision) !== expectedRevision + 1) return undefined
  const nodes = denseArray(row.nodes, 8), ready = denseArray(row.readyTaskIds, 8)
  if (!nodes || nodes.length !== pairCount * 2 || !ready) return undefined
  const projected: SafeReceiptNode[] = [], taskIds = new Set<string>(), keys = new Set<string>()
  for (let index = 0; index < nodes.length; index += 2) {
    const writerValue = nodes[index], reviewerValue = nodes[index + 1]
    const writer = plainRecord(writerValue), reviewer = plainRecord(reviewerValue)
    if (!writer || !reviewer || !boundedId(writer.key) || !boundedId(writer.taskId)
      || !boundedId(reviewer.key) || !boundedId(reviewer.taskId) || writer.taskId === reviewer.taskId
      || writer.status !== "queued" || reviewer.status !== "waiting"
      || taskIds.has(writer.taskId) || taskIds.has(reviewer.taskId) || keys.has(writer.key) || keys.has(reviewer.key)) return undefined
    const correctionKeys = correctionSlotId && objectiveTailorCorrectionNodeKeys(correctionSlotId)
    const writerSlot = /^objective-tailor-wave-writer-(tailor-[1-8])$/.exec(writer.key)?.[1]
    const reviewerSlot = /^objective-tailor-wave-reviewer-(tailor-[1-8])$/.exec(reviewer.key)?.[1]
    if (correctionSlotId ? !correctionKeys || writer.key !== correctionKeys.writerNodeKey || reviewer.key !== correctionKeys.reviewerNodeKey
      : !writerSlot || writerSlot !== reviewerSlot) return undefined
    taskIds.add(writer.taskId); taskIds.add(reviewer.taskId); keys.add(writer.key); keys.add(reviewer.key)
    projected.push({ key: writer.key, taskId: writer.taskId, status: "queued" })
    projected.push({ key: reviewer.key, taskId: reviewer.taskId, status: "waiting" })
  }
  const readyTaskIds: string[] = []
  for (let index = 0; index < projected.length; index += 2) readyTaskIds.push(projected[index]!.taskId)
  if (ready.length !== pairCount || ready.some((taskId, index) => taskId !== readyTaskIds[index])) return undefined
  return { status: row.status, revision: Number(row.revision), nodes: projected, readyTaskIds }
}

function denseArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return undefined
    const result: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(value, String(index))
      if (!item?.enumerable || !("value" in item)) return undefined
      result.push(item.value)
    }
    return result
  } catch { return undefined }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
        || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

function commandFailure(error: unknown): ToolExecutionError {
  const codeValue = dataProperty(error, "code"), revision = dataProperty(error, "currentRevision")
  const code = typeof codeValue === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(codeValue)
    ? codeValue : "objective_tailor_wave_failed"
  const safeOutput = Number.isSafeInteger(revision) && typeof revision === "number" && revision >= 0
    ? { code, currentRevision: revision } : { code }
  return new ToolExecutionError(code, "The selected candidates could not be added to the current objective graph", safeOutput)
}

function dataProperty(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object") return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}
