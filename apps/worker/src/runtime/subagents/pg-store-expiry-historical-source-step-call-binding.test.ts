import { describe, expect, it } from "vitest"
import { historicalSourceStepCallChainBinding } from "./pg-store-expiry-historical-source-step-call-binding.js"

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

describe("historical source step call binding", () => {
  const sql = historicalSourceStepCallChainBinding("proof.value->'sourceStepPrefix'")

  it("rebinds each persisted call and result to one complete ordered lifecycle", () => {
    expect(sqlBalance(sql)).toBe(0)
    expect(sql).toContain(`callItem."type" = 'tool_call'`)
    expect(sql).toContain(`resultItem."type" = 'tool_result'`)
    expect(sql).toContain('callStarted."causationId" = callItemStarted."id"')
    expect(sql).toContain('terminal."causationId" = callCompleted."id"')
    expect(sql).toContain('resultCompleted."causationId" = resultStarted."id"')
    expect(sql).toContain('resultCompleted."payload" = jsonb_build_object')
    expect(sql).toContain('callItemStarted."causationId" = (SELECT priorResultCompleted."id"')
    expect(sql).toContain('earlierCall."stepId" = boundSource."id"')
    expect(sql).toContain("':attempt:' || boundSource.\"attempt\"::text")
    expect(sql).toContain('earlierStart."sequence" BETWEEN')
    expect(sql).toContain('priorStart."sequence" < callItemStarted."sequence"')
  })

  it("counts only canonical attempt items and the exact bounded event grammar", () => {
    expect(sql).toContain("':item:tool-call:'")
    expect(sql).toContain("':item:tool-result:'")
    expect(sql).toContain("':item:tool-result:source-wait-recovery:'")
    expect(sql).toContain('boundSource."attempt"::text')
    expect(sql).toContain("jsonb_array_length(")
    expect(sql).toContain("5 + (SELECT COUNT(*)")
    expect(sql).toContain('AS commentItem WHERE commentItem."sessionId"')
    expect(sql).toContain('AS commentStarted')
    expect(sql).toContain('AS agenda')
  })
})
