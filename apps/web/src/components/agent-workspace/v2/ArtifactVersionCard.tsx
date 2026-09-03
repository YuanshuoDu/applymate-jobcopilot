"use client"

import React from "react"

import type { ArtifactSummary } from "./types"

export interface ArtifactVersionCardProps {
  readonly artifact: ArtifactSummary
  readonly onRequestReview?: (id: string) => void
}

export function ArtifactVersionCard({ artifact, onRequestReview }: ArtifactVersionCardProps) {
  const stale = artifact.status === "stale"
  return (
    <article aria-label="Artifact version" data-artifact-id={artifact.artifactId} data-artifact-status={artifact.status} style={{ ...cardStyle, borderColor: stale ? "var(--c-error)" : "var(--border)" }}>
      <div style={headerStyle}><strong>Artifact v{artifact.version}</strong><span style={statusStyle(stale)}>{artifact.status}</span></div>
      <code style={{ display: "block", overflowWrap: "anywhere", color: "var(--text-muted)", fontSize: 11 }}>{artifact.artifactId}</code>
      {artifact.hash && <code style={{ display: "block", marginTop: 5, overflowWrap: "anywhere", color: "var(--text-muted)", fontSize: 10 }}>{artifact.hash}</code>}
      {stale && <p style={{ color: "var(--c-error)", fontSize: 12 }}>This artifact is stale and must be reviewed again.</p>}
      {stale && onRequestReview && <button type="button" onClick={() => onRequestReview(artifact.artifactId)} style={buttonStyle}>Request review</button>}
    </article>
  )
}

const cardStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 10, padding: 14, background: "var(--bg)" }
const headerStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }
const statusStyle = (stale: boolean): React.CSSProperties => ({ color: stale ? "var(--c-error)" : "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" })
const buttonStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", color: "var(--text)", background: "var(--bg)", cursor: "pointer" }
