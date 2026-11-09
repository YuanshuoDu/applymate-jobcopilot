import { describe, expect, it } from "vitest"
import { parseScheduledPostGatePlan } from "./scheduled-post-gate-plan.js"
import {
  SCHEDULED_POST_GATE_AUDIT_CRITERIA, SCHEDULED_POST_GATE_AUDIT_GOAL, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_CRITERIA, SCHEDULED_POST_GATE_EXECUTE_GOAL, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID,
} from "./scheduled-post-gate-contract.js"
import type { TaskGraphProposal } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"

const approved = ["package-a", "package-b", "package-c"]
const typedVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} satisfies TaskGraphVerificationContract
function execute(key: string, packageRefs: readonly string[]) {
  return { key, templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, goal: SCHEDULED_POST_GATE_EXECUTE_GOAL,
    successCriteria: SCHEDULED_POST_GATE_EXECUTE_CRITERIA, dependsOn: ["gate"], packageRefs }
}
function audit(dependencies: readonly string[]) {
  return { key: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
    goal: SCHEDULED_POST_GATE_AUDIT_GOAL, successCriteria: SCHEDULED_POST_GATE_AUDIT_CRITERIA, dependsOn: dependencies }
}
function proposal(nodes: TaskGraphProposal["nodes"]): TaskGraphProposal { return { expectedRevision: 7, nodes } }

describe("scheduled post-Gate plan shape", () => {
  it("accepts one to three Execute partitions and an Audit depending on every Execute", () => {
    const two = proposal([execute("execute-a", [approved[0]!]), execute("execute-b", [approved[1]!, approved[2]!]),
      audit(["execute-b", "execute-a"])])
    expect(parseScheduledPostGatePlan(two, 7, approved)).toMatchObject({ packageRefs: approved,
      executeNodes: [{ key: "execute-a" }, { key: "execute-b" }], auditNode: { key: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID } })
    const three = proposal([execute("execute-a", [approved[0]!]), execute("execute-b", [approved[1]!]),
      execute("execute-c", [approved[2]!]), audit(["execute-a", "execute-b", "execute-c"])])
    expect(parseScheduledPostGatePlan(three, 7, approved)?.executeNodes).toHaveLength(3)
  })

  it("accepts exactly one empty Execute only when Gate approved no refs", () => {
    const value = proposal([execute("execute-empty", []), audit(["execute-empty"])])
    expect(parseScheduledPostGatePlan(value, 7, [])?.executeNodes[0]?.packageRefs).toEqual([])
    expect(parseScheduledPostGatePlan(proposal([execute("execute-a", []), execute("execute-b", []),
      audit(["execute-a", "execute-b"])]), 7, [])).toBeNull()
  })

  it.each([
    ["missing package", [execute("execute-a", [approved[0]!, approved[1]!]), execute("execute-b", []), audit(["execute-a", "execute-b"]) ]],
    ["duplicate package", [execute("execute-a", [approved[0]!, approved[1]!]), execute("execute-b", [approved[1]!, approved[2]!]), audit(["execute-a", "execute-b"]) ]],
    ["extra package", [execute("execute-a", [approved[0]!, approved[1]!, "package-x"]), execute("execute-b", [approved[2]!]), audit(["execute-a", "execute-b"]) ]],
  ] as const)("rejects %s across Execute partitions", (_label, nodes) => {
    expect(parseScheduledPostGatePlan(proposal(nodes), 7, approved)).toBeNull()
  })

  it("rejects sparse refs, sparse criteria, and sparse dependency arrays", () => {
    const sparseRefs = new Array<string>(2)
    sparseRefs[1] = approved[0]!
    expect(parseScheduledPostGatePlan(proposal([execute("execute-a", sparseRefs), execute("execute-b", approved.slice(1)),
      audit(["execute-a", "execute-b"])]), 7, approved)).toBeNull()
    const sparseCriteria = [...SCHEDULED_POST_GATE_EXECUTE_CRITERIA] as string[]
    delete sparseCriteria[0]
    expect(parseScheduledPostGatePlan(proposal([{ ...execute("execute-a", approved.slice(0, 1)), successCriteria: sparseCriteria },
      execute("execute-b", approved.slice(1)), audit(["execute-a", "execute-b"])]), 7, approved)).toBeNull()
    const sparseDependencies = new Array<string>(2)
    sparseDependencies[1] = "execute-b"
    expect(parseScheduledPostGatePlan(proposal([execute("execute-a", approved.slice(0, 1)),
      execute("execute-b", approved.slice(1)), audit(sparseDependencies)]), 7, approved)).toBeNull()
  })

  it("requires the exact graph revision and exact server-owned node shapes", () => {
    const valid = proposal([execute("execute-a", approved), audit(["execute-a"])])
    expect(parseScheduledPostGatePlan(valid, 8, approved)).toBeNull()
    expect(parseScheduledPostGatePlan({ ...valid, nodes: [
      { ...valid.nodes[0]!, verification: typedVerification }, valid.nodes[1]!,
    ] }, 7, approved)).toBeNull()
    expect(parseScheduledPostGatePlan(proposal([execute("execute-a", approved), audit([])]), 7, approved)).toBeNull()
    expect(parseScheduledPostGatePlan(proposal([execute("execute-a", approved), audit(["execute-a", "extra-edge"])]), 7, approved)).toBeNull()
  })
})
