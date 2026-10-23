import type pg from "pg"
import type { PolicyEngine, RuntimePolicyDecision } from "@jobcopilot/agent-policy"
import { ToolRegistry } from "../tools/registry.js"
import type { ArtifactToolExecutionContext, ArtifactToolRevisionContext } from "../tools/artifact-tools.js"
import type { ToolCallRequest, ToolExecutionResult } from "../tools/types.js"
import { getSubagentRolePolicy } from "./role-policy.js"
import { canManageChildrenWithWaitAction } from "./child-executor-admission.js"
import { createDurableSubagentWaitTool } from "./durable-subagent-wait-tool.js"
import type { PrivateArtifactToolContext } from "./child-private-artifact.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

export function registerProductionChildWaitTool(input: {
  readonly pool: Pick<pg.Pool, "connect">
  readonly task: Pick<SubagentTaskRecord, "role" | "allowedActions">
  readonly lease: SubagentLease
  readonly registry: Pick<ToolRegistry, "register">
}): boolean {
  const policy = getSubagentRolePolicy(input.task.role)
  if (!canManageChildrenWithWaitAction(policy, input.task.allowedActions)) return false
  input.registry.register(createDurableSubagentWaitTool(input.pool, input.lease))
  return true
}

export function createPrivateSelectedJobToolExecutor(input: {
  readonly task: Pick<SubagentTaskRecord, "role">
  readonly writerReviewRevision?: ArtifactToolRevisionContext
  readonly registry: ToolRegistry
  readonly policy: PolicyEngine
  readonly recordPolicyDecision: (decision: RuntimePolicyDecision) => Promise<void>
}): (context: PrivateArtifactToolContext, request: ToolCallRequest) => Promise<ToolExecutionResult> {
  return async (context, request) => {
    const privateRead = request.toolName === "artifact.version.read" && (input.task.role === "reviewer" || (input.task.role === "writer" && Boolean(input.writerReviewRevision)))
    const privateDraft = input.task.role === "writer" && request.toolName === "cover_letter.draft"
    const privateReview = input.task.role === "reviewer" && request.toolName === "artifact.review"
    if ((!privateRead && !privateDraft && !privateReview) || request.toolVersion !== "1" || context.actorRole !== "subagent") {
      throw new Error("private_artifact_read_unavailable")
    }
    const definition = input.registry.resolve(request.toolName, request.toolVersion)
    const validRead = definition.risk === "read" && definition.domain === "resume" && definition.idempotency === "read_only"
      && definition.capabilities.length === 1 && definition.capabilities[0] === "read" && definition.requiredCapabilities.length === 0
    const validDraft = definition.risk === "draft_write" && definition.domain === "resume" && definition.idempotency === "requires_key"
      && definition.capabilities.length === 2 && definition.capabilities.includes("read") && definition.capabilities.includes("write")
      && definition.requiredCapabilities.length === 0
    const validReview = validDraft && definition.name === "artifact.review"
    if ((privateRead && !validRead) || ((privateDraft || privateReview) && !validDraft) || (privateReview && !validReview)) {
      throw new Error("private_artifact_read_unavailable")
    }
    const decision = input.policy.evaluate({
      scope: context.scope, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
      toolCallId: request.id, actorRole: context.actorRole, capabilities: context.capabilities ?? [],
      tool: { name: definition.name, version: definition.version, risk: definition.risk, domain: definition.domain,
        capabilities: definition.capabilities, requiredCapabilities: definition.requiredCapabilities },
      input: request.input,
    })
    await input.recordPolicyDecision(decision)
    if (decision.outcome !== "allow") throw new Error("private_artifact_tool_policy_denied")
    const effectiveInput = decision.safeInput === undefined ? request.input : decision.safeInput
    if (input.registry.validateArguments(request.toolName, effectiveInput, request.toolVersion) !== true) {
      throw new Error("private_artifact_read_input_invalid")
    }
    const parentSignal = context.signal
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    if (parentSignal?.aborted) controller.abort()
    else parentSignal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, definition.timeoutMs)
    const executionContext: ArtifactToolExecutionContext = {
      scope: context.scope, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
      toolCallId: request.id, taskId: context.taskId, rootTaskId: context.rootTaskId, actorRole: context.actorRole,
      remainingTurnSteps: context.remainingTurnSteps, selectedJobPreparation: context.selectedJobPreparation, taskFence: context.taskFence,
      signal: controller.signal, capabilities: context.capabilities ?? [],
      reportProgress: async () => {
        if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled")
      },
    }
    try {
      if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled")
      const output = await definition.execute(executionContext, effectiveInput)
      if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled")
      input.registry.validators.validate(definition.outputSchema, output, `${request.toolName} output`)
      return { id: request.id, toolName: request.toolName, toolVersion: request.toolVersion, status: "completed", output, errorCode: null }
    } finally {
      clearTimeout(timer)
      parentSignal?.removeEventListener("abort", onAbort)
    }
  }
}
