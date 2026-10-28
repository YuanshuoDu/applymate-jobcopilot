import { projectScheduledPipelineGraphAtCurrentStage, type ScheduledPipelineGraphNode } from "./scheduled-pipeline-graph-shape.js"

/** Selects the persisted Gate-prefix verifier only after a valid Gate or Audit suffix was appended. */
export function scheduledPrepareGateVerifierStage(nodes: readonly ScheduledPipelineGraphNode[]): "gate" | "audit" | null {
  const current = projectScheduledPipelineGraphAtCurrentStage(nodes)
  return current?.projection.stage === "gate" || current?.projection.stage === "audit" ? current.projection.stage : null
}
