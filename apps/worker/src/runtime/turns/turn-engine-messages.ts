import type { HarnessModelRequest, ModelContinuation, ModelMessage } from "@jobcopilot/agent-model"
import type { ModelCapabilityProfile, ModelAdapter } from "@jobcopilot/agent-model"

import type { StepContext } from "../context/step-context-builder.js"
import { buildCognitiveActionAgenda, cognitiveActionAgendaText } from "./cognitive-action-agenda.js"
import { buildCognitiveControlFrame, cognitiveControlFrameText } from "./cognitive-control-frame.js"
import { buildCognitiveMemoryRecall, cognitiveMemoryRecallText } from "./cognitive-memory-recall.js"

export const PLAN_REPLAN_SYSTEM_INSTRUCTION = "SERVER CONTROL: A child task failure requires replanning. Output exactly one agent.plan.propose tool call for a new plan based on the failed plan revision and current goal. Do not call any other tool and do not return final text."
export const PLAN_REPLAN_STEERING_OVERRIDE_INSTRUCTION = "SERVER CONTROL: Fresh authenticated user steering is available while replanning is required. If it explicitly changes the goal, output exactly one agent.goal.update tool call reflecting that change. Otherwise output exactly one agent.plan.propose tool call based on the failed plan revision and current goal. Do not call any other tool and do not return final text."
export const CANONICAL_PLANNER_CONTRACT_INSTRUCTION = [
  "SERVER PLANNER CONTRACT (ADVISORY): Propose a plan object with schemaVersion, basedOnGoalRevision, basedOnPlanRevision, nodes, completionCriteria, and briefRationale.",
  "Each node should include localId, kind, objective, inputRefs, dependsOn, successCriteria, and outputSchemaRef.",
  "Delegate nodes should also include role, taskType, and constraints; join nodes should include joinMode; request_input nodes should include question and approvalBoundary.",
  "Every dependency must be completed before its dependent node runs. The deterministic server validator is the only authority; this guidance does not change Type.Unknown compatibility or validation.",
  "Delegate nodes may use only roles in the server allowlist. Use outputSchemaRef exactly \"agent-harness.v2.subagent.result\" only for scout or analyst when a machine-aggregated structured result is required. Reviewer and auditor are unstructured and must not claim that schema.",
  "The server validates plans and injects internal result markers; never provide identity, lease, capability, permission, or authorization fields.",
].join(" ")
const CANONICAL_PLAN_TOOL_NAME = "agent.plan.propose"

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function blockText(block: StepContext["blocks"][number]): string {
  const trust = block.trust === "external_untrusted" ? "UNTRUSTED_DATA" : block.trust
  return `[harness context layer=${block.layer} trust=${trust} source=${block.source}]\n${stableJson(block.content)}`
}

function hasCanonicalPlanTool(tools: readonly unknown[]): boolean {
  return tools.some(tool => tool !== null && typeof tool === "object" && !Array.isArray(tool) && (tool as Record<string, unknown>).name === CANONICAL_PLAN_TOOL_NAME)
}

export function contextToModelMessages(context: StepContext, replanRequired = false, freshSteering = false, plannerContract = false): ModelMessage[] {
  const messages: ModelMessage[] = []
  if (replanRequired) {
    const text = freshSteering ? PLAN_REPLAN_STEERING_OVERRIDE_INSTRUCTION : PLAN_REPLAN_SYSTEM_INSTRUCTION
    messages.push({ role: "system", content: [{ type: "text", text }] })
  }
  if (plannerContract) messages.push({ role: "system", content: [{ type: "text", text: CANONICAL_PLANNER_CONTRACT_INSTRUCTION }] })
  messages.push({ role: "system", content: [{ type: "text", text: cognitiveControlFrameText(buildCognitiveControlFrame(context, { replanRequired, freshSteering })) }] })
  const memoryRecall = buildCognitiveMemoryRecall(context)
  if (memoryRecall) messages.push({ role: "system", content: [{ type: "text", text: cognitiveMemoryRecallText(memoryRecall) }] })
  messages.push({ role: "system", content: [{ type: "text", text: cognitiveActionAgendaText(buildCognitiveActionAgenda(context, { replanRequired, freshSteering })) }] })
  for (const block of context.blocks) {
    const observation = block.layer === "tool_observation" ? asToolObservation(block.content) : null
    if (observation) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: observation.toolCallId, name: observation.toolName, input: observation.input }],
      })
      messages.push({
        role: "tool",
        content: [{
          type: "tool_result",
          toolUseId: observation.toolCallId,
          content: stableJson(observation.output),
          ...(observation.status !== "completed" ? { isError: true } : {}),
        }],
      })
      continue
    }
    messages.push({
      role: block.role === "instruction" ? "system" : "user",
      content: [{ type: "text", text: blockText(block) }],
    })
  }
  if (context.blocks.length === 0) messages.push({ role: "user", content: [{ type: "text", text: "Continue the Turn according to the harness contract." }] })
  return messages
}

type ToolObservation = {
  toolCallId: string
  toolName: string
  input: unknown
  output: unknown
  status: string
}

function asToolObservation(value: unknown): ToolObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.toolCallId !== "string" || !record.toolCallId.trim() ||
    typeof record.toolName !== "string" || !record.toolName.trim() || typeof record.status !== "string") return null
  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    input: record.input ?? {},
    output: record.output ?? null,
    status: record.status,
  }
}

function capabilities(profile: ModelCapabilityProfile) {
  return {
    nativeTools: profile.nativeTools,
    structuredOutput: profile.structuredOutput,
    streaming: profile.streaming,
    continuationCursor: profile.continuationCursor,
  }
}

export function buildModelRequest(input: {
  context: StepContext
  model: ModelAdapter
  tools: readonly unknown[]
  sessionId: string
  turnId: string
  stepId: string
  userId: string
  taskId: string
  signal: AbortSignal
  maxOutputTokens?: number
  continuation?: ModelContinuation
  replanRequired?: boolean
  freshSteering?: boolean
}): HarnessModelRequest {
  return {
    schemaVersion: "agent-harness.v2",
    provider: input.model.profile.provider,
    model: input.model.profile.model,
    messages: contextToModelMessages(input.context, input.replanRequired === true, input.freshSteering === true && input.replanRequired === true, hasCanonicalPlanTool(input.tools)),
    tools: [...input.tools],
    capabilities: capabilities(input.model.profile),
    ...(input.model.profile.nativeTools && input.tools.length > 0 ? { toolChoice: "auto" as const } : {}),
    ...(input.model.profile.continuationCursor && input.continuation ? { continuation: input.continuation } : {}),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    signal: input.signal,
    metadata: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      taskId: input.taskId,
      userId: input.userId,
      featureId: "agent-harness.turn",
      traceId: `${input.turnId}:${input.stepId}`,
    },
  }
}
