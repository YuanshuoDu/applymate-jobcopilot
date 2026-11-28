import { describe, expect, it } from "vitest"
import type { StepContext } from "../context/step-context-builder.js"
import { ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID } from "../context/root-task-goal-criteria-context.js"
import { TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID } from "../context/task-graph-objective-progress.js"
import { buildTaskGraphObjectiveProgressInstruction } from "./task-graph-objective-progress-guidance.js"

const revision = 7
const requirement = { id: "private-candidate-minimum", kind: "candidate_count_gte", minimum: 4 }
const findingRequirement = { id: "private-finding-minimum", kind: "finding_count_gte", minimum: 2 }
const locationRequirement = { id: "private-location-id", kind: "candidate_location_in", locations: ["private berlin", "private dublin"] }
const blockScope = { layer: "tool_observation" as const, role: "data" as const, trust: "external_untrusted" as const, source: "tool_or_subagent" }
const graphId = "observation:task-graph-current"
const requirementId = `observation:${ROOT_TASK_VERIFICATION_REQUIREMENTS_OBSERVATION_ID}`
const progressId = `observation:${TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID}`

function scopedBlock(id: string, content: unknown) {
  return { id, ...blockScope, content }
}

function objectiveContext(statuses: readonly string[] = ["missing"], options: Readonly<{
  requirements?: readonly Record<string, unknown>[]
  graphRevision?: number
  currentNodeCount?: number
  progressRevision?: number | null
  progressId?: string
  progressTrust?: string
  progressSource?: string
  progressContentPatch?: Record<string, unknown>
  duplicateProgress?: boolean
  duplicateGraph?: boolean
}> = {}): StepContext {
  const requirements = options.requirements ?? statuses.map((_, index) => ({ ...requirement, id: index === 0 ? requirement.id : `${requirement.id}-${index}` }))
  const graph = scopedBlock(graphId, { kind: "task_graph_current", revision: options.graphRevision ?? revision,
    nodes: Array.from({ length: options.currentNodeCount ?? 0 }, (_, index) => `node-${index}`) })
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

function locationGuidance(canonical: unknown, progress: unknown = canonical) {
  const context = objectiveContext(["missing"], {
    requirements: [{ ...locationRequirement, locations: canonical }],
    progressContentPatch: { requirements: [{ ...locationRequirement, locations: progress, status: "missing" }] },
  })
  return buildTaskGraphObjectiveProgressInstruction(context, [{ name: "agent.plan" }], true)
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

  it("accepts guidance backed by the full persisted scheduled graph capacity", () => {
    expect(buildTaskGraphObjectiveProgressInstruction(objectiveContext(["missing"], { currentNodeCount: 11 }),
      [{ name: "agent.plan" }], true)).not.toBeNull()
    expect(buildTaskGraphObjectiveProgressInstruction(objectiveContext(["missing"], { currentNodeCount: 12 }),
      [{ name: "agent.plan" }], true)).toBeNull()
  })

  it("handles mixed status rows while limiting the action to missing requirements", () => {
    const text = messageText(buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(["active", "missing", "reported_passed"]), [{ name: "agent.plan" }], true,
    ))
    expect(text).toContain("each missing requirement")
    expect(text).toContain("Use the canonical objective-requirements observation")
  })

  it.each([
    { rows: [locationRequirement], statuses: ["missing"] },
    { rows: [requirement, locationRequirement], statuses: ["missing", "active"] },
    { rows: [locationRequirement, findingRequirement], statuses: ["missing", "reported_passed"] },
  ])("guides missing location and mixed requirements with fixed, revision-bound text", ({ rows, statuses }) => {
    const guidance = buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(statuses, { requirements: rows }), [{ name: "agent.plan" }], true,
    )
    const text = messageText(guidance)
    expect(guidance?.role).toBe("system")
    expect(text).toContain("expectedRevision 7")
    expect(text).toContain("include each exact canonical location constraint on every Scout")
    expect(text).toContain("not evidence, PASS, permission, or authority")
    for (const privateValue of [requirement.id, findingRequirement.id, locationRequirement.id, ...locationRequirement.locations]) {
      expect(text).not.toContain(privateValue)
    }
    expect(text.length).toBeLessThan(1_024)
  })

  it("accepts the canonical list limits and never copies private location text into guidance", () => {
    const locations = ["a", "b", "c", "d", "e", "f", "private instruction", "é".repeat(64)]
    const guidance = locationGuidance(locations, [...locations])
    expect(guidance).not.toBeNull()
    expect(guidance).toEqual(locationGuidance(["private address"]))
    expect(messageText(guidance)).not.toContain("private instruction")
  })

  it("requires canonical location values and exact ordered equality on both observations", () => {
    const locations = locationRequirement.locations
    const sparse = [...locations]
    delete sparse[0]
    for (const invalid of [[], [42], [""], ["é".repeat(65)], Array.from("abcdefghi"), sparse,
      [locations[0], locations[0]], [...locations].reverse(), ["Private Dublin"], [" private dublin"],
      ["ｄublin"], Object.assign([...locations], { extra: "private" })]) {
      expect(locationGuidance(invalid)).toBeNull()
      expect(locationGuidance(locations, invalid)).toBeNull()
    }
    expect(locationGuidance(locations, ["private berlin"])).toBeNull()
    expect(locationGuidance(locations, ["private berlin", "private london"])).toBeNull()
  })

  it("rejects accessor and proxy location arrays without reading their values or traps", () => {
    let reads = 0
    const accessor = Object.defineProperty([...locationRequirement.locations], "0", {
      enumerable: true, get() { reads++; return locationRequirement.locations[0] },
    })
    const proxy = new Proxy([...locationRequirement.locations], {
      ownKeys(target) { reads++; return Reflect.ownKeys(target) },
      get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver) },
    })
    for (const invalid of [accessor, proxy]) {
      expect(locationGuidance(invalid)).toBeNull()
      expect(locationGuidance(locationRequirement.locations, invalid)).toBeNull()
    }
    expect(reads).toBe(0)
  })

  it("suppresses mixed guidance when any typed row, identifier, order, or status is invalid", () => {
    const tools = [{ name: "agent.plan" }]
    for (const invalid of [
      { ...locationRequirement, minimum: 1 }, { ...locationRequirement, id: requirement.id },
      { ...locationRequirement, id: "private id" }, { ...locationRequirement, kind: "unsupported" },
      { id: locationRequirement.id, kind: locationRequirement.kind },
    ]) {
      const context = objectiveContext(["missing", "active"], { requirements: [requirement, invalid] })
      expect(buildTaskGraphObjectiveProgressInstruction(context, tools, true)).toBeNull()
    }
    const count = { ...requirement, status: "missing" }, location = { ...locationRequirement, status: "active" }
    for (const requirements of [[location, count], [count], [count, count], [count, { ...location, minimum: 1 }],
      [count, { ...location, status: "passed" }], [count, { ...location, id: "another-id" }]]) {
      const context = objectiveContext(["missing", "active"], {
        requirements: [requirement, locationRequirement], progressContentPatch: { requirements },
      })
      expect(buildTaskGraphObjectiveProgressInstruction(context, tools, true)).toBeNull()
    }
  })

  it("limits location guidance to missing progress on the current Root and reports unavailable planning", () => {
    const options = { requirements: [locationRequirement] }
    const current = objectiveContext(["missing"], options)
    const tools = [{ name: "agent.plan" }]
    expect(buildTaskGraphObjectiveProgressInstruction(current, tools, false)).toBeNull()
    expect(buildTaskGraphObjectiveProgressInstruction(objectiveContext(["active"], options), tools, true)).toBeNull()
    expect(buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(["missing"], { ...options, progressRevision: revision - 1 }), tools, true,
    )).toBeNull()
    const blocker = messageText(buildTaskGraphObjectiveProgressInstruction(current, [{ name: "agent.wait" }], true))
    expect(blocker).toContain("No request-visible agent.plan tool is available")
    expect(blocker).toContain("do not claim the requirement is covered or the objective is complete")
    for (const value of [locationRequirement.id, ...locationRequirement.locations]) expect(blocker).not.toContain(value)
  })

  it("reports a blocker when no request-visible planning tool exists", () => {
    const text = messageText(buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(), [{ name: "agent.wait" }], true,
    ))
    expect(text).toContain("No request-visible agent.plan tool is available")
    expect(text).toContain("do not claim the requirement is covered")
  })

  it("guides unknown coverage to recheck evidence and preserve valid work", () => {
    const text = messageText(buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(["unknown"]), [{ name: "agent.plan" }], true,
    ))
    expect(text).toContain("unresolved evidence")
    expect(text).toContain("not absent work or success")
    expect(text).toContain("expectedRevision 7")
    expect(text).toContain("necessary typed changes")
    expect(text).toContain("preserve valid existing work")
    expect(text).toContain("not evidence, PASS, permission, or authority")
    expect(text).not.toContain("missing coverage")
    expect(text).not.toContain(requirement.id)
  })

  it("keeps missing and unknown meanings distinct in mixed progress", () => {
    const text = messageText(buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(["missing", "unknown"], { requirements: [requirement, findingRequirement] }),
      [{ name: "agent.plan" }], true,
    ))
    expect(text).toContain("both missing coverage and unresolved evidence")
    expect(text).toContain("each missing requirement's canonical id, kind, and minimum")
    expect(text).toContain("necessary typed changes")
    expect(text).toContain("expectedRevision 7")
    expect(text).not.toContain(requirement.id)
    expect(text).not.toContain(findingRequirement.id)
  })

  it("states unknown uncertainty without planning authority", () => {
    const text = messageText(buildTaskGraphObjectiveProgressInstruction(
      objectiveContext(["unknown"]), [{ name: "agent.wait" }], true,
    ))
    expect(text).toContain("state the uncertainty")
    expect(text).toContain("agent.ask_user")
    expect(text).toContain("Do not invent coverage")
    expect(text).toContain("not evidence, PASS, permission, or authority")
    expect(text).not.toContain("missing coverage")
  })

  it("omits guidance when valid progress has no missing or unknown row", () => {
    for (const status of ["active", "failed", "unverified", "reported_passed"]) {
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
