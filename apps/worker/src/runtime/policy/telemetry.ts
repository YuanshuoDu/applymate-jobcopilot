import { PolicyDecisionSchema, validate, type PolicyDecision as AgentPolicyDecision } from "@jobcopilot/agent-protocol"
import type { RuntimePolicyDecision } from "@jobcopilot/agent-policy"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { ExecutionOwnerFence } from "../execution-owner.js"

import type { PolicyDecisionSink } from "./types.js"

export class InMemoryPolicyDecisionSink implements PolicyDecisionSink {
  readonly decisions: AgentPolicyDecision[] = []

  append(decision: AgentPolicyDecision): void {
    this.decisions.push({ ...decision, scope: { ...decision.scope } })
  }

  replay(): AgentPolicyDecision[] {
    return this.decisions.map((decision) => ({ ...decision, scope: { ...decision.scope } }))
  }
}

/** Build the exact protocol projection persisted for a terminal tool-policy decision. */
export function durablePolicyDecisionProjection(
  decision: RuntimePolicyDecision,
  owner: ExecutionOwnerFence,
): AgentPolicyDecision {
  if (decision.hook !== "before_tool_use" || decision.outcome === "rewrite_input") {
    throw new Error("policy_decision_projection_invalid")
  }
  const projected: AgentPolicyDecision = {
    schemaVersion: decision.schemaVersion,
    policyVersion: decision.policyVersion,
    hook: decision.hook,
    outcome: decision.outcome,
    reasonCode: boundedRedactedText(decision.reasonCode, 256),
    reason: boundedRedactedText(decision.reason, 512),
    scope: {
      userId: owner.userId,
      sessionId: owner.sessionId,
      turnId: owner.turnId,
      stepId: decision.scope.stepId,
      toolCallId: decision.scope.toolCallId,
      toolName: decision.scope.toolName,
      toolVersion: decision.scope.toolVersion,
      role: decision.scope.role,
      domain: decision.scope.domain,
      risk: decision.scope.risk,
    },
  }
  if (!validate(PolicyDecisionSchema, projected)) throw new Error("policy_decision_projection_invalid")
  return projected
}

function boundedRedactedText(value: string, maxLength: number): string {
  const result = redactSensitiveText(value).slice(0, maxLength)
  if (result.length === 0) throw new Error("policy_decision_projection_invalid")
  return result
}
