import { describe, expect, it } from "vitest"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { canRecoverMissingEvidence } from "./final-evidence-recovery-eligibility.js"

type EligibilityInput = Parameters<typeof canRecoverMissingEvidence>[0]

function options(overrides: Partial<TurnExecutionOptions> = {}): TurnExecutionOptions {
  return {
    identity: { kind: "turn", taskId: "root-1", rootTaskId: "root-1" } as TurnExecutionOptions["identity"],
    tools: [{ name: "jobs.search" }],
    ...overrides,
  } as unknown as TurnExecutionOptions
}

function snapshot(system: StepContextSnapshot["system"] = []): StepContextSnapshot {
  return { system, profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } as StepContextSnapshot
}

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    options: options(), snapshot: snapshot(), evidenceCount: 0, evidenceRefs: [],
    blocker: "No verifiable evidence is attached to the candidate final", stepCount: 30,
    ...overrides,
  }
}

describe("canRecoverMissingEvidence", () => {
  it("allows one recovery for an eligible root turn with two default steps remaining", () => {
    expect(canRecoverMissingEvidence(input())).toBe(true)
  })

  it.each([
    ["a non-root turn", input({ options: options({ identity: { kind: "turn", taskId: "child-1", rootTaskId: "root-1" } as TurnExecutionOptions["identity"] }) })],
    ["a task identity", input({ options: options({ identity: { kind: "task", taskId: "root-1", rootTaskId: "root-1" } as TurnExecutionOptions["identity"] }) })],
    ["a different blocker", input({ blocker: "another blocker" })],
    ["existing evidence", input({ evidenceCount: 1 })],
    ["an evidence reference", input({ evidenceRefs: ["job-1"] })],
    ["configured expected evidence", input({ options: options({ expectedEvidence: ["job-1"] }) })],
    ["a failed business check", input({ options: options({ businessChecks: [{ name: "role_found", ok: false }] as unknown as TurnExecutionOptions["businessChecks"] }) })],
    ["a recovery already used", input({ options: options({ resume: { finalEvidenceRecoveryUsed: true } as TurnExecutionOptions["resume"] }) })],
    ["a recovery marker in the snapshot", input({ snapshot: snapshot([{ id: "completion-recovery:final-evidence-once", content: "recovery" }]) })],
    ["no visible evidence reader", input({ options: options({ tools: [{ name: "agent.plan" }] }) })],
    ["an unsafe maximum step count", input({ options: options({ budget: { maxSteps: Number.NaN } as TurnExecutionOptions["budget"] }) })],
    ["an unsafe current step count", input({ stepCount: Number.NaN })],
    ["fewer than two remaining steps", input({ options: options({ budget: { maxSteps: 31 } }) })],
  ])("rejects %s", (_name, candidate) => {
    expect(canRecoverMissingEvidence(candidate)).toBe(false)
  })
})
