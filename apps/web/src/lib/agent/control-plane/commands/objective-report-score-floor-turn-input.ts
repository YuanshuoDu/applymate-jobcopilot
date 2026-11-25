import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, parseObjectiveReportScoreFloor } from "@jobcopilot/agent-protocol"

import type { CommandIdentity, ObjectiveVerificationRequirements, ServerAgentTurnIntent } from "./types"

type OptionalObjectiveTurnInput = Readonly<{
  verificationRequirements?: ObjectiveVerificationRequirements | null
  reportScoreFloor?: number
}>

/** Builds immutable Objective root-input metadata without turning reporting into verification. */
export function objectiveReportScoreFloorTurnInput(
  command: CommandIdentity & { reportScoreFloor?: unknown },
  intent: ServerAgentTurnIntent | undefined,
  verificationRequirements: ObjectiveVerificationRequirements | null | undefined,
): OptionalObjectiveTurnInput {
  let reportScoreFloor: number | undefined
  let descriptor: PropertyDescriptor | undefined
  try { descriptor = Object.getOwnPropertyDescriptor(command, "reportScoreFloor") } catch {
    throw new Error("objective_report_score_floor_binding_invalid")
  }
  if (descriptor) {
    const parsed = "value" in descriptor && descriptor.enumerable
      ? parseObjectiveReportScoreFloor(descriptor.value) : null
    if (parsed === null || command.source !== "user" ||
      intent?.kind !== OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind ||
      intent.version !== OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version) {
      throw new Error("objective_report_score_floor_binding_invalid")
    }
    reportScoreFloor = parsed
  }
  return {
    ...(verificationRequirements !== undefined ? { verificationRequirements } : {}),
    ...(reportScoreFloor !== undefined ? { reportScoreFloor } : {}),
  }
}