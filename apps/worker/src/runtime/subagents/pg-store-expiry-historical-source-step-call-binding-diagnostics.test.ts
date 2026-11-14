import { describe, expect, it } from "vitest"
import { historicalSourceStepCallChainBinding } from "./pg-store-expiry-historical-source-step-call-binding.js"
import { historicalSourceStepCallChainDiagnosticSql } from "./pg-store-expiry-historical-source-step-call-binding-diagnostics.js"

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

describe("historical source call-chain diagnostics", () => {
  const path = "proof.value->'sourceStepPrefix'"
  const production = historicalSourceStepCallChainBinding(path)
  const diagnostic = historicalSourceStepCallChainDiagnosticSql(path)

  it("reuses each production segment in the final binding", () => {
    expect(sqlBalance(production)).toBe(0)
    expect(production).toContain(diagnostic.itemCardinality)
    expect(production).toContain(diagnostic.allItems)
    expect(production).toContain(diagnostic.commentCardinality)
    expect(production).toContain(diagnostic.eventCardinality)
    expect(production).toContain(diagnostic.anchorChain)
    expect(production).toContain(diagnostic.finalClose)
    expect(production).toContain(`${diagnostic.validCallCount} = ${diagnostic.callCount}`)
  })

  it("bounds per-call diagnostics to anonymous predicate flags", () => {
    expect(sqlBalance(diagnostic.perCallChecks)).toBe(0)
    expect(diagnostic.perCallChecks).toContain("'isSourceWait'")
    expect(diagnostic.perCallChecks).toContain("'contentValid'")
    expect(diagnostic.perCallChecks).toContain("'eventChainValid'")
    expect(diagnostic.perCallChecks).toContain('jsonb_agg(checks."flags"')
    expect(diagnostic.perCallChecks).toContain("LIMIT 17")
  })
})
