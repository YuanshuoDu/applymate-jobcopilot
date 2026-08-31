import type { PolicyDecision as AgentPolicyDecision } from "@jobcopilot/agent-protocol"

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
