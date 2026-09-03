import type { RuntimeToolDefinition } from "../tools/types.js"

import { getSubagentRolePolicy, preflightSubagentTool, type ApprovalReceiptHint, type PreflightDecision, visibleSubagentTools } from "./role-policy.js"
import type { SubagentExecutionResult, SubagentTaskSpec } from "./types.js"

export type ExecutorPreflightRequest = {
  readonly toolName: string
  readonly toolVersion: string
  readonly input?: unknown
}

export type ExecutorPreflightResult = PreflightDecision & {
  readonly mode: "preflight_only"
}

export class ExecutorHandler {
  readonly role = "executor" as const

  visibleTools(tools: readonly RuntimeToolDefinition[], receipt?: ApprovalReceiptHint): RuntimeToolDefinition[] {
    return visibleSubagentTools(this.role, tools, receipt)
  }

  preflight(tool: RuntimeToolDefinition | null, request: ExecutorPreflightRequest, receipt?: ApprovalReceiptHint): ExecutorPreflightResult {
    if (tool && (tool.name !== request.toolName || tool.version !== request.toolVersion)) {
      return { ...preflightSubagentTool(this.role, null, receipt), toolName: request.toolName, toolVersion: request.toolVersion, mode: "preflight_only" }
    }
    return { ...preflightSubagentTool(this.role, tool, receipt), mode: "preflight_only" }
  }

  async runPreflight(tool: RuntimeToolDefinition | null, request: ExecutorPreflightRequest, receipt?: ApprovalReceiptHint): Promise<SubagentExecutionResult> {
    return { status: "completed", result: { role: this.role, mode: "preflight_only", preflight: this.preflight(tool, request, receipt) } }
  }
}

export function createExecutorTaskSpec(input: Omit<SubagentTaskSpec, "role" | "allowedActions" | "toolPolicySnapshot">): SubagentTaskSpec {
  const policy = getSubagentRolePolicy("executor")
  return {
    ...input,
    role: "executor",
    allowedActions: ["inspect_application_state", "inspect_resume_state", "preflight_action"],
    toolPolicySnapshot: { role: "executor", mode: "preflight_only", capabilities: policy?.capabilities ?? [], externalWrites: false },
  }
}
