import { describe, expect, it } from "vitest"
import { historicalSourceStepWindowUnionBinding } from "./pg-store-expiry-historical-source-step-continuation-window-binding.js"

const path = "proof.value->'sourceStepPrefix'"
function balance(sql: string): number {
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

describe("historical source continuation window SQL", () => {
  it("closes a numeric full-window disjoint union and keeps source-only closure exact", () => {
    const sql = historicalSourceStepWindowUnionBinding(path)
    expect(balance(sql)).toBe(0)
    expect(sql).toContain('windowEvent."sequence" BETWEEN')
    expect(sql).toContain("jsonb_array_length")
    expect(sql).toContain("unnest")
    expect(sql).toContain("USING (sequence)")
    expect(sql).toContain(`outsideProof."id" = ANY`)
    expect(sql).not.toContain(`sequence"::text BETWEEN`)
  })
})
