import { describe, expect, it } from "vitest"
import type { StepContext } from "../context/step-context-builder.js"
import { ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID } from "../context/root-task-goal-criteria-context.js"
import { TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID } from "../context/task-graph-objective-progress.js"
import { buildTaskGraphObjectiveProgressInstruction } from "./task-graph-objective-progress-guidance.js"

const revision = 7
const requirement = { id: "private-candidate-minimum", kind: "candidate_count_gte", minimum: 4 }
const blockScope = { layer: "tool_observation" as const, role: "data" as const, trust: "external_untrusted" as const, source: "tool_or_subagent" }
const graphId = "observation:task-graph-current"
const requirementId = `observation:${ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID}`
const progressId = `observation:${TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID}`

function scopedBlock(id: string, content: unknown) {
  return { id, ...blockScope, content }
}

function objectiveContext(statuses: readonly string[] = ["missing"], options: Readonly<{
  graphRevision?: number
  progressRevision?: number | null
  progressId?: string
  progressTrust?: string
  progressSource?: string
  progressContentPatch?: Record<string, unknown>
  duplicateProgress?: boolean
  duplicateGraph?: boolean
}> = {}): StepContext {
  const requirements = statuses.map((_, index) => ({ ...requirement, id: index === 0 ? requirement.id : `${requirement.id}-${index}` }))
  const graph = scopedBlock(graphId, { kind: "task_graph_current", revision: options.graphRevision ?? revision, nodes: [] })
  const canonical = scopedBlock(requirementId, {
    kind: "canonical_objective_verification_requirements", trust: "external_untrusted", source: "canonical_turn_objective",
    status: "valid", requirements,
  })
  const progress = scopedBlock(options.progressId ?? progressId, {
    schemaVersion: "agent-harness.v2.objective-progress.v1", advisory: true,
    revision: options.progressRevision === undefined ? revision : options.progressRevision,
    requirements: requirements.map((row, index) => ({ ...row, status: statuses[index] })),
    ...options.progressContentPatch,
  })
  const blocks = [graph, canonical, {
    ...progress,
    ...(options.progressTrust === undefined ? {} : { trust: options.progressTrust }),
    ...(options.progressSource === undefined ? {} : { source: options.progressSource }),
  }, ...(options.duplicateProgress ? [progress] : []), ...(options.duplicateGraph ? [graph] : [])]
  return {
    schemaVersion: "agent-harness.v2", sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    inputThroughSequence: 1n, consumedInputIds: [], canonicalJson: "{}", taskGraphRevision: revision,
    blocks,
  } as unknown as StepContext
}

function messageText(value: ReturnType<typeof buildTaskGraphObjectiveProgressInstruction>): string {
  if (!value) return ""
  return value.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
}

describe("missing TaskGraph objective progress guidance", () => {
  it("guides a current Root to plan missing typed coverage at the validated revision without copying criterion data", () => {
    const guidance = buildTaskGraphObjectiveProgressInstruction(objectiveContext(), [{ name: "agent.plan", version: "1" }], true)
    const text = messageText(guidance)

    expect(guidance?.role).toBe("system")
    expect(text).toContain("Current structured objective progress reports at least one missing requirement")
    expect(text).toContain("expectedRevision 7")
    expect(text).toContain("canonical id, kind, and minimum")
    expect(text).toContain("not evidence, PASS, permission, or authority")
    expect(text).not.toContain(requirement.id)
    expect(text.length).toBeLessThan(1_024)
  })

  it("handles mixed status rows while limiting the action to missing requirements", () => {
    const text = messageText(buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(["active", "missing", "reported_passed"]), [{ name: "agent.plan" }], true,
    ))
    expect(text).toContain("each missing requirement")
    expect(text).toContain("Use the canonical objective-requirements observation")
  })

  it("reports a blocker when no request-visible planning tool exists", () => {
    const text = messageText(buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(), [{ name: "agent.wait" }], true,
    ))
    expect(text).toContain("No request-visible agent.plan tool is available")
    expect(text).toContain("do not claim the requirement is covered")
  })

  it("omits guidance when valid progress has no missing row", () => {
    for (const status of ["active", "failed", "unverified", "reported_passed", "unknown"]) {
      expect(buildTaskGraphObjectiveProgressInstruction(objectiveContext([status]), [{ name: "agent.plan" }], true)).toBeNull()
    }
  })

  it("fails closed on stale, malformed, foreign, duplicate, or unbound context", () => {
    const base = objectiveContext()
    const noProgress = { ...base, blocks: base.blocks.filter(block => block.id !== progressId) }
    const wrongContextSchema = { ...base, schemaVersion: "agent-harness.v1" } as unknown as StepContext
    const staleContext = { ...base, taskGraphRevision: revision + 1 }
    const malformed = objectiveContext(["missing"], { progressContentPatch: { extra: "private" } })
    const foreign = objectiveContext(["missing"], { progressId: "observation:foreign-objective-progress" })
    const duplicateProgress = objectiveContext(["missing"], { duplicateProgress: true })
    const duplicateGraph = objectiveContext(["missing"], { duplicateGraph: true })
    const wrongTrust = objectiveContext(["missing"], { progressTrust: "internal_record" })
    const wrongSource = objectiveContext(["missing"], { progressSource: "user_input" })
    const staleProgress = objectiveContext(["missing"], { progressRevision: revision - 1 })
    const staleGraph = objectiveContext(["missing"], { graphRevision: revision - 1 })
    const canonicalBlock = base.blocks.find(block => block.id === requirementId)!
    const duplicateCanonical = { ...base, blocks: [...base.blocks, canonicalBlock] }

    for (const context of [noProgress, wrongContextSchema, staleContext, malformed, foreign, duplicateProgress, duplicateGraph,
      duplicateCanonical, wrongTrust, wrongSource, staleProgress, staleGraph]) {
      expect(buildTaskGraphObjectiveProgressInstruction(context, [{ name: "agent.plan" }], true)).toBeNull()
    }
  })

  it("rejects requirement identifiers with a trailing line terminator in both canonical and progress packets", () => {
    const base = objectiveContext()
    const blocks = base.blocks.map(block => {
      if (block.id !== requirementId && block.id !== progressId) return block
      const content = block.content as Record<string, unknown>
      const requirements = (content.requirements as Array<Record<string, unknown>>).map(row => ({ ...row, id: `${row.id}\n` }))
      return { ...block, content: { ...content, requirements } }
    })
    expect(buildTaskGraphObjectiveProgressInstruction({ ...base, blocks }, [{ name: "agent.plan" }], true)).toBeNull()
  })

  it("omits guidance if canonical requirements disagree with the progress packet", () => {
    const base = objectiveContext()
    const blocks = base.blocks.map(block => block.id === requirementId
      ? { ...block, content: { kind: "canonical_objective_verification_requirements", trust: "external_untrusted",
        source: "canonical_turn_objective", status: "valid", requirements: [{ ...requirement, minimum: 5 }] } }
      : block)
    expect(buildTaskGraphObjectiveProgressInstruction({ ...base, blocks }, [{ name: "agent.plan" }], true)).toBeNull()
  })

  it("allows 512 observation inputs plus canonical and Root context blocks while rejecting oversized contexts", () => {
    const base = objectiveContext()
    const rootBlocks = [
      { id: "system:root", layer: "system", role: "instruction", trust: "system", source: "harness", content: "Keep objective evidence authoritative." },
      { id: "goal:root", layer: "goal", role: "data", trust: "external_untrusted", source: "turn_goal", content: "Find candidates." },
    ]
    const fillerBlocks = (count: number) => Array.from({ length: count }, (_, index) =>
      scopedBlock(`observation:tool-result:bounded-${index}`, { toolName: "jobs.search" }))
    const maximumObservationContext = { ...base, blocks: [...rootBlocks, ...base.blocks, ...fillerBlocks(510)] }
    expect(maximumObservationContext.blocks).toHaveLength(515)
    expect(buildTaskGraphObjectiveProgressInstruction(maximumObservationContext as unknown as StepContext, [{ name: "agent.plan" }], true)).not.toBeNull()

    const oversizedContext = { ...base, blocks: [...rootBlocks, ...base.blocks, ...fillerBlocks(1_020)] }
    expect(oversizedContext.blocks).toHaveLength(1_025)
    expect(buildTaskGraphObjectiveProgressInstruction(oversizedContext as unknown as StepContext, [{ name: "agent.plan" }], true)).toBeNull()
  })

  it("does not inspect accessor-backed tool names or emit a false unavailable-tool instruction", () => {
    const tool = Object.defineProperty({}, "name", { enumerable: true, get: () => { throw new Error("must not invoke tool getter") } })
    expect(buildTaskGraphObjectiveProgressInstruction(objectiveContext(), [tool], true)).toBeNull()
  })
})
