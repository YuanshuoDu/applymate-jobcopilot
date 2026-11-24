import { describe, expect, it, vi } from "vitest"
import { createAgentTailorTool } from "./tools/agent-tailor.js"
import { createAgentTailorWaveTool } from "./tools/agent-tailor-wave.js"
import { objectiveTailorVersionFromRootTools, registerCanonicalObjectiveTailorTool } from "./canonical-turn-objective-tailor-mode.js"
import { OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE } from "./subagents/objective-tailor-wave-profile.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"

const options = { turnLeaseOwner: "worker-1", turnLeaseVersion: 1, parentLeaseOwner: "worker-1", parentAttemptCount: () => 1 }
const port = {
  readObjectiveTailorCatalog: vi.fn(async () => undefined), appendObjectiveTailor: vi.fn(async () => ({})),
  readObjectiveTailorWaveCatalog: vi.fn(async () => undefined), appendObjectiveTailorWave: vi.fn(async () => ({})),
  appendObjectiveTailorCorrection: vi.fn(async () => ({})),
} as unknown as TaskGraphCommandPort
function register(budgetSnapshot: unknown, overrides: Partial<Parameters<typeof registerCanonicalObjectiveTailorTool>[0]> = {}) {
  const definitions: unknown[] = []
  const registry = { register: vi.fn((value: unknown) => definitions.push(value)) }
  const version = registerCanonicalObjectiveTailorTool({ registry, commandPort: port, budgetSnapshot, rootEligible: true,
    flags: { objectiveTailorEnabled: true, objectiveTailorWavesEnabled: true }, options, ...overrides })
  return { definitions, registry, version }
}

describe("canonical Objective Tailor tool version", () => {
  it("preserves v1 for ordinary budget snapshots and selects only v2 for the exact wave profile", () => {
    const legacy = register({})
    expect(legacy.version).toBe("1")
    expect(legacy.definitions).toHaveLength(1)
    expect(legacy.definitions[0]).toMatchObject({ name: "agent.tailor", version: "1" })
    const wave = register({ limits: { maxSteps: 96 }, objectiveTailorProfile: OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE })
    expect(wave.version).toBe("2")
    expect(wave.definitions).toHaveLength(1)
    expect(wave.definitions[0]).toMatchObject({ name: "agent.tailor", version: "2" })
  })

  it("never falls back to v1 for disabled, invalid, or incomplete wave profiles", () => {
    for (const value of [
      { limits: { maxSteps: 32 }, objectiveTailorProfile: OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE },
      { limits: { maxSteps: 96 }, objectiveTailorProfile: "unsupported" },
    ]) expect(register(value).definitions).toHaveLength(0)
    expect(register({ limits: { maxSteps: 96 }, objectiveTailorProfile: OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE },
      { flags: { objectiveTailorEnabled: true, objectiveTailorWavesEnabled: false } }).definitions).toHaveLength(0)
    expect(register({ limits: { maxSteps: 96 }, objectiveTailorProfile: OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE },
      { commandPort: { readObjectiveTailorWaveCatalog: vi.fn() } as unknown as TaskGraphCommandPort }).definitions).toHaveLength(0)
    expect(register({ limits: { maxSteps: 96 }, objectiveTailorProfile: OBJECTIVE_TAILOR_WAVE_BUDGET_PROFILE },
      { commandPort: { readObjectiveTailorWaveCatalog: vi.fn(), appendObjectiveTailorWave: vi.fn() } as unknown as TaskGraphCommandPort }).definitions).toHaveLength(0)
    expect(register({}, { rootEligible: false }).definitions).toHaveLength(0)
  })

  it("requires exactly one visible version for model validation and persistence", () => {
    expect(objectiveTailorVersionFromRootTools([{ name: "agent.tailor", version: "2" }])).toBe("2")
    expect(objectiveTailorVersionFromRootTools([
      { name: "agent.tailor", version: "1" }, { name: "agent.tailor", version: "2" },
    ])).toBe("ambiguous")
    expect(objectiveTailorVersionFromRootTools([{ name: "agent.tailor", version: "3" }])).toBe("ambiguous")
    expect(objectiveTailorVersionFromRootTools([{ name: "agent.tailor" }])).toBe("ambiguous")
    expect(objectiveTailorVersionFromRootTools([{ name: "agent.wait", version: "2" }])).toBeUndefined()
    expect(createAgentTailorTool).toBeTypeOf("function")
    expect(createAgentTailorWaveTool).toBeTypeOf("function")
  })
})
