export type ProductionAgentFlags = {
  readonly planningEnabled: boolean
  readonly planningExecutionEnabled: boolean
}

/** Resolve server-owned planning gates; model input and policy snapshots cannot change them. */
export function resolveProductionAgentFlags(env: Record<string, string | undefined> = process.env): ProductionAgentFlags {
  const planningEnabled = env.ENABLE_AGENT_PLANNING === "1"
  return {
    planningEnabled,
    planningExecutionEnabled: planningEnabled && env.ENABLE_AGENT_PLAN_EXECUTION === "1",
  }
}
