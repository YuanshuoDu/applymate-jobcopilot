export type ProductionAgentFlags = {
  readonly cognitiveLoopEnabled: boolean
  readonly planningEnabled: boolean
  readonly planningExecutionEnabled: boolean
  readonly taskGraphPlanningEnabled: boolean
  readonly childExecutionEnabled: boolean
  readonly coordinationEnabled: boolean
  readonly consumeWaitOutcomes: boolean
  readonly canonicalAutomationEnabled: boolean
}

/** Resolve server-owned production gates; model input and policy snapshots cannot change them. */
export function resolveProductionAgentFlags(env: Record<string, string | undefined> = process.env): ProductionAgentFlags {
  const cognitiveLoopEnabled = env.ENABLE_AGENT_COGNITIVE_LOOP === "1"
  const planningEnabled = cognitiveLoopEnabled || env.ENABLE_AGENT_PLANNING === "1"
  const planningExecutionEnabled = cognitiveLoopEnabled || (planningEnabled && env.ENABLE_AGENT_PLAN_EXECUTION === "1")
  // Keep child execution and coordination behind their independent reviewed gates.
  const childExecutionEnabled = env.ENABLE_AGENT_CHILD_EXECUTION === "1"
  const coordinationEnabled = childExecutionEnabled && env.ENABLE_AGENT_WAIT_RESOLVER === "1"
  // TaskGraph has a dedicated planning gate and also requires active runtime prerequisites.
  const taskGraphPlanningEnabled = env.ENABLE_AGENT_TASK_GRAPH_PLANNING === "1"
    && env.ENABLE_AGENT_CHILD_EXECUTION === "1"
    && env.ENABLE_AGENT_WAIT_RESOLVER === "1"
  return {
    cognitiveLoopEnabled,
    planningEnabled,
    planningExecutionEnabled,
    taskGraphPlanningEnabled,
    childExecutionEnabled,
    coordinationEnabled,
    consumeWaitOutcomes: coordinationEnabled,
    canonicalAutomationEnabled: env.ENABLE_AGENT_CANONICAL_AUTOMATION === "1",
  }
}
