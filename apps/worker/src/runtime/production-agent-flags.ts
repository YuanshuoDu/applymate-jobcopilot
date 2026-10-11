export type ProductionAgentFlags = {
  readonly taskGraphPlanningEnabled: boolean
  readonly childExecutionEnabled: boolean
  readonly coordinationEnabled: boolean
  readonly consumeWaitOutcomes: boolean
  readonly canonicalAutomationEnabled: boolean
  readonly turnBoundaryCompactionEnabled: boolean
  readonly nativeSemanticProgressMemoryEnabled?: boolean
}

/** Resolve server-owned production gates; model input and policy snapshots cannot change them. */
export function resolveProductionAgentFlags(env: Record<string, string | undefined> = process.env): ProductionAgentFlags {
  // Keep child execution and coordination behind their independent reviewed gates.
  const childExecutionEnabled = env.ENABLE_AGENT_CHILD_EXECUTION === "1"
  const coordinationEnabled = childExecutionEnabled && env.ENABLE_AGENT_WAIT_RESOLVER === "1"
  // TaskGraph has a dedicated planning gate and also requires active runtime prerequisites.
  const taskGraphPlanningEnabled = env.ENABLE_AGENT_TASK_GRAPH_PLANNING === "1"
    && env.ENABLE_AGENT_CHILD_EXECUTION === "1"
    && env.ENABLE_AGENT_WAIT_RESOLVER === "1"
  return {
    taskGraphPlanningEnabled,
    childExecutionEnabled,
    coordinationEnabled,
    consumeWaitOutcomes: coordinationEnabled,
    canonicalAutomationEnabled: env.ENABLE_AGENT_CANONICAL_AUTOMATION === "1",
    turnBoundaryCompactionEnabled: env.ENABLE_AGENT_TURN_BOUNDARY_COMPACTION === "1",
    nativeSemanticProgressMemoryEnabled: env.ENABLE_AGENT_NATIVE_SEMANTIC_PROGRESS_MEMORY === "1",
  }
}
