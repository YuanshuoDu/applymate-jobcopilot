"use client"

import React from "react"

import type { PendingApproval } from "./types"

export interface ApprovalBlockProps {
  readonly approval: PendingApproval
  readonly onApprove: (id: string) => void
  readonly onDecline: (id: string, reason: string) => void
  readonly readOnly: boolean
}

export function ApprovalBlock({ approval, onApprove, onDecline, readOnly }: ApprovalBlockProps) {
  const answered = readOnly || approval.answeredAt !== undefined && approval.answeredAt !== null
  return (
    <section aria-label="Approval request" data-agent-approval-id={approval.approvalId} style={cardStyle}>
      <div style={headerStyle}><strong>Approval required</strong><span style={mutedStyle}>{approval.action ?? "External action"}</span></div>
      <dl style={detailsStyle}>
        <dt>Scope</dt><dd data-approval-scope={approval.scopeHash}>{approval.scopeHash}</dd>
        <dt>Expires</dt><dd>{approval.expiresAt}</dd>
      </dl>
      <div style={{ display: "grid", gap: 4 }}>
        <strong style={{ fontSize: 11 }}>Evidence</strong>
        {approval.evidenceRefs.length === 0 ? <span style={mutedStyle}>No evidence attached</span> : approval.evidenceRefs.map(ref => <EvidenceRef key={ref} value={ref} />)}
      </div>
      {answered ? <p style={mutedStyle}>Decision already recorded.</p> : (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button type="button" onClick={() => onApprove(approval.approvalId)} style={approveStyle}>Approve</button>
          <button type="button" onClick={() => onDecline(approval.approvalId, "declined_by_user")} style={declineStyle}>Decline</button>
        </div>
      )}
    </section>
  )
}

function EvidenceRef({ value }: { readonly value: string }) {
  if (/^https?:\/\//i.test(value)) return <a href={value} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>{value}</a>
  return <code style={{ fontSize: 11 }}>{value}</code>
}

const cardStyle: React.CSSProperties = { border: "1px solid var(--border)", borderLeft: "4px solid var(--primary)", borderRadius: 10, padding: 14, background: "var(--bg)" }
const headerStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 10, fontSize: 13 }
const detailsStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "68px 1fr", gap: "5px 8px", margin: "0 0 12px", fontSize: 11 }
const mutedStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: 11 }
const approveStyle: React.CSSProperties = { border: 0, borderRadius: 6, padding: "7px 12px", color: "white", background: "var(--primary)", cursor: "pointer" }
const declineStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: "7px 12px", color: "var(--text)", background: "var(--bg)", cursor: "pointer" }
