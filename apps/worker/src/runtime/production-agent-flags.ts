export type ProductionAgentFlags = {
  readonly cognitiveLoopEnabled: boolean
  readonly planningEnabled: boolean
  readonly planningExecutionEnabled: boolean
  readonly contextCompactionEnabled: boolean
  readonly canonicalAutomationEnabled: boolean
}

/** Resolve server-owned production gates; model input and policy snapshots cannot change them. */
export function resolveProductionAgentFlags(env: Record<string, string | undefined> = process.env): ProductionAgentFlags {
  const cognitiveLoopEnabled = env.ENABLE_AGENT_COGNITIVE_LOOP === "1"
  const planningEnabled = cognitiveLoopEnabled || env.ENABLE_AGENT_PLANNING === "1"
  return {
    cognitiveLoopEnabled,
    planningEnabled,
    planningExecutionEnabled: cognitiveLoopEnabled || (planningEnabled && env.ENABLE_AGENT_PLAN_EXECUTION === "1"),
    contextCompactionEnabled: env.ENABLE_AGENT_CONTEXT_COMPACTION === "1",
    canonicalAutomationEnabled: cognitiveLoopEnabled || env.ENABLE_AGENT_CANONICAL_AUTOMATION === "1",
  }
}
