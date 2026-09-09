import { PolicyEngine, type PolicySnapshot } from "@jobcopilot/agent-policy"

const FALLBACK_POLICY: PolicySnapshot = {
  version: "policy.v1",
  rules: [
    {
      id: "canonical-root-coordination",
      roles: ["orchestrator"], tools: ["spawn_subagent", "send_message", "wait_subagents", "interrupt_subagent", "close_subagent"],
      risks: ["internal_write"], domains: ["coordination"], requiredCapabilities: ["canManageChildren"],
      outcome: "allow", reasonCode: "server_coordination_gate", reason: "The server enabled scoped root coordination tools",
    },
    {
      id: "canonical-root-coordination-read",
      roles: ["orchestrator"], tools: ["list_subagents"], risks: ["read"], domains: ["coordination"], requiredCapabilities: ["canManageChildren"],
      outcome: "allow", reasonCode: "server_coordination_read_gate", reason: "The server enabled scoped root coordination reads",
    },
    {
      id: "canonical-root-planning",
      roles: ["orchestrator"], tools: ["agent.plan.propose", "agent.goal.update"], risks: ["internal_write"], domains: ["coordination"], requiredCapabilities: ["canPlan"],
      outcome: "allow", reasonCode: "server_planning_gate", reason: "The server enabled bounded plan proposals",
    },
    {
      id: "canonical-root-read",
      roles: ["orchestrator"], risks: ["read"],
      outcome: "allow", reasonCode: "safe_read_baseline", reason: "Read-only tools use the canonical safe baseline",
    },
  ],
}

function fallbackPolicy(coordinationEnabled: boolean, planningEnabled: boolean): PolicySnapshot {
  const enabled = new Set(["canonical-root-read", ...(coordinationEnabled ? ["canonical-root-coordination", "canonical-root-coordination-read"] : []), ...(planningEnabled ? ["canonical-root-planning"] : [])])
  return { ...FALLBACK_POLICY, rules: FALLBACK_POLICY.rules.filter(rule => enabled.has(rule.id)) }
}

function missingSnapshot(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 0 || !keys.some(key => key === "version" || key === "rules")
}

export function createCanonicalPolicy(value: unknown, coordinationEnabled = false, planningEnabled = false): PolicyEngine {
  if (missingSnapshot(value)) {
    return new PolicyEngine(coordinationEnabled || planningEnabled ? { snapshot: fallbackPolicy(coordinationEnabled, planningEnabled) } : {})
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("canonical_policy_snapshot_invalid")
  return new PolicyEngine({ snapshot: value as unknown as PolicySnapshot })
}
