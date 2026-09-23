import { PolicyEngine, type PolicySnapshot } from "@jobcopilot/agent-policy"

const COORDINATION_WRITE_TOOL_NAMES = [
  "spawn_subagent", "agent.spawn", "agent.followup",
  "send_message", "agent.send", "wait_subagents", "agent.wait",
  "interrupt_subagent", "agent.interrupt", "close_subagent", "agent.close",
]
const COORDINATION_READ_TOOL_NAMES = ["list_subagents", "agent.list"]

const FALLBACK_POLICY: PolicySnapshot = {
  version: "policy.v1",
  rules: [
    {
      id: "canonical-root-coordination",
      roles: ["orchestrator"], tools: COORDINATION_WRITE_TOOL_NAMES,
      risks: ["internal_write"], domains: ["coordination"], requiredCapabilities: ["canManageChildren"],
      outcome: "allow", reasonCode: "server_coordination_gate", reason: "The server enabled scoped root coordination tools",
    },
    {
      id: "canonical-root-coordination-read",
      roles: ["orchestrator"], tools: COORDINATION_READ_TOOL_NAMES, risks: ["read"], domains: ["coordination"], requiredCapabilities: ["canManageChildren"],
      outcome: "allow", reasonCode: "server_coordination_read_gate", reason: "The server enabled scoped root coordination reads",
    },
    {
      id: "canonical-root-read",
      roles: ["orchestrator"], risks: ["read"],
      outcome: "allow", reasonCode: "safe_read_baseline", reason: "Read-only tools use the canonical safe baseline",
    },
  ],
}

function fallbackPolicy(coordinationEnabled: boolean): PolicySnapshot {
  const enabled = new Set(["canonical-root-read", ...(coordinationEnabled ? ["canonical-root-coordination", "canonical-root-coordination-read"] : [])])
  return { ...FALLBACK_POLICY, rules: FALLBACK_POLICY.rules.filter(rule => enabled.has(rule.id)) }
}

function missingSnapshot(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 0 || !keys.some(key => key === "version" || key === "rules")
}

export function createCanonicalPolicy(value: unknown, coordinationEnabled = false): PolicyEngine {
  if (missingSnapshot(value)) {
    return new PolicyEngine(coordinationEnabled ? { snapshot: fallbackPolicy(coordinationEnabled) } : {})
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("canonical_policy_snapshot_invalid")
  return new PolicyEngine({ snapshot: value as unknown as PolicySnapshot })
}
