import { describe, expect, it } from "vitest"
import { historicalSourceStepEventChainBinding } from "./pg-store-expiry-historical-source-step-parent-binding.js"

function sqlBalance(sql: string): number {
  let depth = 0, quote: "'" | '"' | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (quote) { if (char === quote) { if (sql[index + 1] === quote) { index += 1; continue } quote = null } continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth < 0) return depth
  }
  return quote ? Number.NaN : depth
}

describe("historical source step parent binding", () => {
  const sql = historicalSourceStepEventChainBinding("proof.value->'sourceStepPrefix'")

  it("accepts only a canonical earlier task start or the nearest same-attempt prior step close", () => {
    expect(sqlBalance(sql)).toBe(0)
    expect(sql).toContain("parent.\"sequence\" < chain.\"actualSequence\"")
    expect(sql).toContain("parent.\"type\" = 'task.started'")
    expect(sql).toContain("parent.\"idempotencyKey\" = 'task:' || boundSource.\"taskId\" || ':event:turn-started'")
    expect(sql).toContain("priorStep.\"attempt\" = boundSource.\"attempt\"")
    expect(sql).toContain("candidate.\"ordinal\" < boundSource.\"ordinal\"")
    expect(sql).toContain("parent.\"type\" = 'step.completed'")
    expect(sql).toContain("chain.value->>'causationId' = chain.\"previousId\"")
    expect(sql).not.toContain("chain.value->'causationId' = 'null'::jsonb")
  })

  it("keeps the source start bound to its exact scoped payload", () => {
    expect(sql).toContain("chain.value->>'correlationId' = boundSource.\"id\"")
    expect(sql).toContain("actual.\"sessionId\" = boundSource.\"sessionId\"")
    expect(sql).toContain("actual.\"turnId\" = boundSource.\"turnId\"")
    expect(sql).toContain("actual.\"taskId\" = boundSource.\"taskId\"")
    expect(sql).toContain("'ordinal', boundSource.\"ordinal\"")
  })
})
