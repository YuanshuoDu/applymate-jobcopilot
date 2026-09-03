import type { ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type { StepContext } from "../runtime/context/step-context-builder.js"
import { createPgTurnEngineStore } from "../runtime/turns/turn-engine-store.js"
import { runTurnJob, type TurnExecutionResult } from "../runtime/turns/turn-queue.js"
import { TurnEngine } from "../runtime/turns/turn-engine.js"
import { toRepositoryJson, type TurnEngineOptions } from "../runtime/turns/turn-engine-types.js"
import type { LeasePool } from "../runtime/turns/lease.js"
import type { AgentRunTaskPayload } from "./agent-run-queue.js"
import { pinnedFetch } from "@jobcopilot/shared"

const PIPELINE_TOOL = {
  schemaVersion: "agent-harness.v2",
  name: "pipeline.run",
  version: "1",
  description: "Run or resume the job application preparation pipeline.",
  inputSchema: { type: "object", additionalProperties: false, properties: { mode: { enum: ["resume", "start"] } } },
  domain: "automation",
  risk: "internal_write",
  capabilities: ["read", "write", "coordination"],
  idempotency: "per_turn",
} as const

const PIPELINE_SNAPSHOT: TurnEngineOptions["snapshot"] = {
  system: [{ id: "pipeline-adapter", content: "Execute the pipeline tool exactly once, then report its result." }],
  profile: [], steerHistory: [], businessRefs: [], toolObservations: [],
}

function contextBuilder() {
  return {
    async build(input: Parameters<TurnEngineOptions["contextBuilder"]["build"]>[0]): Promise<StepContext> {
      const blocks: StepContext["blocks"] = [
        { id: "pipeline-adapter", layer: "system", role: "instruction", trust: "system", source: "pipeline_adapter", content: "Call pipeline.run once. Do not perform external submission." },
        { id: "pipeline-goal", layer: "goal", role: "data", trust: "internal_record", source: "automation", content: "Run the queued Agent pipeline and preserve its checkpointed result." },
        ...input.snapshot.toolObservations.map((observation) => ({
          id: observation.id, layer: "tool_observation" as const, role: "data" as const,
          trust: "internal_record" as const, source: "pipeline.run", content: toRepositoryJson(observation.content),
        })),
      ]
      return {
        schemaVersion: "agent-harness.v2", sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId,
        inputThroughSequence: 0n, consumedInputIds: [], blocks, canonicalJson: JSON.stringify(blocks),
      }
    },
  }
}

function adapter(): ModelAdapter {
  let callCount = 0
  return {
    id: "pipeline-turn-adapter",
    profile: {
      provider: "applymate", model: "pipeline-turn-adapter", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
      supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
      supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
      maxContextTokens: null, maxOutputTokens: 256, costClass: "low",
    },
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      callCount += 1
      if (callCount === 1) {
        yield { type: "tool_call_completed", callId: "pipeline.run", name: "pipeline.run", arguments: { mode: "resume" } }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      const hasFailure = request.messages.some((message) => JSON.stringify(message).includes('"status":"failed"'))
      yield { type: "text_delta", text: hasFailure ? "The Agent pipeline failed and can be resumed from its durable checkpoint." : "The Agent pipeline completed." }
      yield { type: "completed", finishReason: "stop" }
    },
  }
}

async function executePipelineTool(task: AgentRunTaskPayload, input: { signal: AbortSignal; callInput: unknown }) {
  const url = process.env.AGENT_WEB_URL?.replace(/\/$/, "")
  const secret = process.env.AGENT_WORKER_SECRET
  if (!url) throw new Error("AGENT_WEB_URL is required for canonical agent runs")
  if (!secret) throw new Error("AGENT_WORKER_SECRET is required for canonical agent runs")
  const response = await pinnedFetch(`${url}/api/internal/agent-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-worker-secret": secret },
    body: JSON.stringify({
      userId: task.userId, sessionId: task.sessionId, turnId: task.turnId, executionId: task.executionId,
      ...(input.callInput && typeof input.callInput === "object" ? input.callInput : {}),
    }),
    signal: input.signal,
  })
  const result = await response.json().catch(() => null) as unknown
  if (response.status === 403) return { status: "failed" as const, errorCode: "authorization_revoked", output: result }
  if (!response.ok) return { status: "failed" as const, errorCode: `pipeline_http_${response.status}`, output: result }
  return { status: "completed" as const, errorCode: null, output: result }
}

export async function runCanonicalAgentTurn(
  task: { data: AgentRunTaskPayload; attemptsMade: number },
  pool: LeasePool,
) {
  const payload = task.data
  if (!payload.turnId) throw new Error("Canonical agent run requires turnId")
  const base: Omit<TurnEngineOptions, "lease" | "signal"> = {
    scope: { userId: payload.userId }, goal: "Run the Agent job pipeline", snapshot: PIPELINE_SNAPSHOT,
    contextBuilder: contextBuilder(), store: createPgTurnEngineStore(pool), model: adapter(), tools: [PIPELINE_TOOL],
    maxSteps: 2, capabilities: ["read", "write", "coordination"],
    executeTool: async ({ signal, call }) => {
      if (call.toolName !== "pipeline.run") return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "failed", errorCode: "unknown_tool" }
      const result = await executePipelineTool(payload, { signal, callInput: call.input })
      return { id: call.id, toolName: call.toolName, toolVersion: "1", ...result }
    },
  }
  const result = await runTurnJob(
    { data: { turnId: payload.turnId, sessionId: payload.sessionId, ownerId: `agent-run:${payload.executionId ?? payload.turnId}` }, attemptsMade: task.attemptsMade },
    { pool, execute: ({ lease, signal }): Promise<TurnExecutionResult> => new TurnEngine({ ...base, lease, signal }).run() },
  )
  return result
}
