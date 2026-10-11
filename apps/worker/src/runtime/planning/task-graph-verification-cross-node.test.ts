import { describe, expect, it } from "vitest"

import {
  TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  taskGraphVerificationDependencyNodeKeys,
  validateTaskGraphVerificationDependencySelectors,
  type TaskGraphVerificationContract,
  type TaskGraphVerificationDependencyGraphNode,
} from "./task-graph-verification.js"

const scoutContract: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
}
const analystContract: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [
    { id: "from-scout-a", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" } },
    { id: "from-scout-b", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-b" } },
    { id: "from-scout-again", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" } },
  ],
}

function scout(key: string): TaskGraphVerificationDependencyGraphNode {
  return { key, templateId: "scout", dependsOn: [], verificationDisposition: "typed", verification: scoutContract }
}
function analyst(dependsOn: readonly string[]): TaskGraphVerificationDependencyGraphNode {
  return { key: "analyst", templateId: "analyst", dependsOn, verificationDisposition: "typed", verification: analystContract }
}

describe("TaskGraph cross-node verification selectors", () => {
  it("selects unique dependency keys in canonical order and accepts direct typed Scout edges", () => {
    expect(taskGraphVerificationDependencyNodeKeys(analystContract)).toEqual(["scout-a", "scout-b"])
    expect(validateTaskGraphVerificationDependencySelectors([scout("scout-b"), scout("scout-a"), analyst(["scout-a", "scout-b"])]))
      .toBe(true)
  })

  it.each([
    ["indirect source", [scout("scout-a"), analyst(["middle"])]],
    ["legacy source", [{ ...scout("scout-a"), verificationDisposition: "legacy_unverified", verification: undefined }, analyst(["scout-a"]) ]],
    ["specialized source", [{ key: "scout-a", templateId: "cover_letter_writer", dependsOn: [], verificationDisposition: "specialized" }, analyst(["scout-a"]) ]],
    ["wrong-role source", [{ ...analyst(["scout-a"]), key: "scout-a" }, analyst(["scout-a"]) ]],
  ] as const)("rejects a selector with a %s", (_label, nodes) => {
    expect(validateTaskGraphVerificationDependencySelectors(nodes as readonly TaskGraphVerificationDependencyGraphNode[])).toBe(false)
  })
})
