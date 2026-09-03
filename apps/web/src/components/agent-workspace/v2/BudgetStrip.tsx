"use client"

import React from "react"

import type { BudgetUsage, CompactionEvent } from "./types"

export interface BudgetStripProps {
  readonly usage: BudgetUsage
  readonly compaction?: CompactionEvent
  /** Supplied by the parent so this component remains deterministic in tests. */
  readonly nowMs: number
}

export function BudgetStrip({ usage, compaction, nowMs }: BudgetStripProps) {
  const percentage = Number.isFinite(usage.percentage) ? Math.max(0, usage.percentage) : 0
  const capped = Math.min(100, percentage)
  const tone = percentage >= 100 ? "var(--c-error)" : percentage >= 90 ? "#b7791f" : "var(--c-success)"
  return (
    <section aria-label="Budget usage" data-budget-tone={percentage >= 100 ? "critical" : percentage >= 90 ? "warning" : "normal"} data-budget-now-ms={nowMs} style={cardStyle}>
      <div style={headerStyle}><strong>Budget</strong><span style={{ color: tone, fontWeight: 700 }}>{Math.round(percentage)}%</span></div>
      <div aria-hidden="true" style={trackStyle}><div style={{ ...fillStyle, width: `${capped}%`, background: tone }} /></div>
      <div style={footerStyle}><span>{usage.tokensUsed.toLocaleString()} / {usage.tokensBudget.toLocaleString()} tokens</span><span>{compaction?.lastCompactionAt ? `Compacted ${compaction.lastCompactionAt}` : "No compaction"}</span></div>
    </section>
  )
}

const cardStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 10, padding: 14, background: "var(--bg)" }
const headerStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }
const trackStyle: React.CSSProperties = { height: 7, marginTop: 10, overflow: "hidden", borderRadius: 5, background: "var(--bg-secondary)" }
const fillStyle: React.CSSProperties = { height: "100%", borderRadius: 5, transition: "width 180ms ease" }
const footerStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8, color: "var(--text-muted)", fontSize: 10 }
