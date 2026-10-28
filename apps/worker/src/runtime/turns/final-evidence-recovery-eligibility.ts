import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { hasFinalEvidenceRecoveryMarker } from "./completion-recovery-context.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"

const DEFAULT_MAX_STEPS = 32
const READ_EVIDENCE_TOOLS = new Set(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"])

function visibleEvidenceReader(tools: readonly unknown[]): boolean {
  return tools.some(tool => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false
    const name = Reflect.get(tool, "name")
    return typeof name === "string" && READ_EVIDENCE_TOOLS.has(name)
  })
}

export function canRecoverMissingEvidence(input: {
  options: TurnExecutionOptions; snapshot: StepContextSnapshot; evidenceCount: number
  evidenceRefs: readonly string[]; blocker: string; stepCount: number
}): boolean {
  const { options } = input
  const maxSteps = options.budget?.maxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS
  return options.identity.kind === "turn" && options.identity.taskId === options.identity.rootTaskId
    && input.blocker === "No verifiable evidence is attached to the candidate final"
    && input.evidenceCount === 0 && input.evidenceRefs.length === 0
    && (!options.expectedEvidence || options.expectedEvidence.length === 0)
    && (!options.businessChecks || options.businessChecks.every(check => check.ok))
    && options.resume?.finalEvidenceRecoveryUsed !== true && !hasFinalEvidenceRecoveryMarker(input.snapshot)
    && visibleEvidenceReader(options.tools) && Number.isSafeInteger(maxSteps) && Number.isSafeInteger(input.stepCount)
    && maxSteps - input.stepCount >= 2
}
