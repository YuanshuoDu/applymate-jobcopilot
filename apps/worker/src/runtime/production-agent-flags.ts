export type ProductionAgentFlags = {
  readonly childExecutionEnabled: boolean
  readonly coordinationEnabled: boolean
  readonly consumeWaitOutcomes: boolean
  readonly canonicalAutomationEnabled: boolean
}

/** Resolve server-owned production gates; model input and policy snapshots cannot change them. */
export function resolveProductionAgentFlags(env: Record<string, string | undefined> = process.env): ProductionAgentFlags {
  const childExecutionEnabled = env.ENABLE_AGENT_CHILD_EXECUTION === "1"
  const coordinationEnabled = childExecutionEnabled && env.ENABLE_AGENT_WAIT_RESOLVER === "1"
  return {
    childExecutionEnabled,
    coordinationEnabled,
    consumeWaitOutcomes: coordinationEnabled,
    canonicalAutomationEnabled: env.ENABLE_AGENT_CANONICAL_AUTOMATION === "1",
  }
}
