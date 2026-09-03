import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BudgetStrip } from "./BudgetStrip"

describe("BudgetStrip", () => {
  it("renders normal usage and compaction metadata", () => {
    const html = renderToStaticMarkup(<BudgetStrip usage={{ tokensUsed: 100, tokensBudget: 1000, percentage: 10 }} compaction={{ lastCompactionAt: "2026-09-03T00:00:00.000Z" }} nowMs={123} />)
    expect(html).toContain('data-budget-tone="normal"')
    expect(html).toContain("100 / 1,000 tokens")
    expect(html).toContain("Compacted")
  })

  it("marks ninety percent usage as warning", () => {
    const html = renderToStaticMarkup(<BudgetStrip usage={{ tokensUsed: 900, tokensBudget: 1000, percentage: 90 }} nowMs={123} />)
    expect(html).toContain('data-budget-tone="warning"')
    expect(html).toContain("90%")
  })

  it("marks exhausted budgets as critical and clamps the bar", () => {
    const html = renderToStaticMarkup(<BudgetStrip usage={{ tokensUsed: 1100, tokensBudget: 1000, percentage: 110 }} nowMs={456} />)
    expect(html).toContain('data-budget-tone="critical"')
    expect(html).toContain('data-budget-now-ms="456"')
    expect(html).toContain('width:100%')
  })
})
