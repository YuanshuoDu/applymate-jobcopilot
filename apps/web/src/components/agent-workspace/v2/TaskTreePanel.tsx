"use client"

import React, { useEffect, useState } from "react"

import type { TaskTreeNode } from "./types"

export interface TaskTreePanelProps {
  readonly nodes: readonly TaskTreeNode[]
  readonly selectedId?: string
  readonly sessionKey?: string
  readonly onSelect: (id: string) => void
}

/** Displays the bounded Turn → Step → Tool hierarchy without executing nodes. */
export function TaskTreePanel({ nodes, selectedId, sessionKey, onSelect }: TaskTreePanelProps) {
  const [localSelectedId, setLocalSelectedId] = useState<string | undefined>(selectedId)

  useEffect(() => {
    setLocalSelectedId(undefined)
  }, [sessionKey])

  const activeSelectedId = sessionKey === undefined ? selectedId : localSelectedId
  const select = (node: TaskTreeNode) => {
    setLocalSelectedId(node.id)
    onSelect(node.id)
    if (node.itemId) scrollToTimelineItem(node.itemId)
  }

  return (
    <section aria-label="Task tree" data-agent-task-tree="true" style={panelStyle}>
      <h2 style={headingStyle}>Task tree</h2>
      <div style={{ display: "grid", gap: 4 }}>{renderNodes(nodes, 0, activeSelectedId, select)}</div>
    </section>
  )
}

export function flattenTaskTree(nodes: readonly TaskTreeNode[], maxDepth = 5): TaskTreeNode[] {
  const result: TaskTreeNode[] = []
  const visit = (entries: readonly TaskTreeNode[], depth: number) => {
    if (depth >= maxDepth) return
    for (const node of entries) {
      result.push(node)
      visit(node.children ?? [], depth + 1)
    }
  }
  visit(nodes, 0)
  return result
}

function renderNodes(nodes: readonly TaskTreeNode[], depth: number, selectedId: string | undefined, onSelect: (node: TaskTreeNode) => void): React.ReactNode {
  if (depth >= 5) return null
  return nodes.map(node => (
    <React.Fragment key={node.id}>
      <button
        type="button"
        data-task-node-id={node.id}
        data-task-tree-depth={depth}
        aria-current={selectedId === node.id ? "true" : undefined}
        onClick={() => onSelect(node)}
        style={{ ...nodeStyle, marginLeft: depth * 16, background: selectedId === node.id ? "var(--bg-secondary)" : "transparent" }}
      >
        <span style={{ color: "var(--primary)", fontSize: 11, fontWeight: 700 }}>{node.kind}</span>
        <span style={{ flex: 1, textAlign: "left" }}>{node.label}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{node.status}</span>
      </button>
      {renderNodes(node.children ?? [], depth + 1, selectedId, onSelect)}
    </React.Fragment>
  ))
}

export function scrollToTimelineItem(itemId: string): void {
  if (typeof document === "undefined") return
  const element = Array.from(document.querySelectorAll<HTMLElement>("[data-agent-harness-item]"))
    .find(candidate => candidate.dataset.agentHarnessItem === itemId)
  element?.scrollIntoView({ behavior: "smooth", block: "center" })
}

const panelStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 10, padding: 14, background: "var(--bg)" }
const headingStyle: React.CSSProperties = { margin: 0, fontSize: 13, color: "var(--text)" }
const nodeStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, border: 0, borderRadius: 6, padding: "7px 8px", color: "var(--text)", cursor: "pointer", font: "inherit" }
