import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { TaskTreePanel, flattenTaskTree } from "./TaskTreePanel"
import type { TaskTreeNode } from "./types"

const nodes: TaskTreeNode[] = [{ id: "turn-1", kind: "turn", label: "Find Berlin roles", status: "running", itemId: "item-turn", children: [{ id: "step-1", kind: "step", label: "Scout jobs", status: "completed", itemId: "item-step", children: [{ id: "tool-1", kind: "tool", label: "jobs.search", status: "completed", itemId: "item-tool" }] }] }]

describe("TaskTreePanel", () => {
  it("renders Turn, Step, and Tool hierarchy", () => {
    const html = renderToStaticMarkup(<TaskTreePanel nodes={nodes} onSelect={vi.fn()} />)
    expect(html).toContain('data-agent-task-tree="true"')
    expect(html).toContain('data-task-tree-depth="2"')
    expect(html).toContain("jobs.search")
  })

  it("bounds the visible tree at five levels", () => {
    let current: TaskTreeNode | undefined
    for (let depth = 5; depth >= 0; depth--) current = { id: `node-${depth}`, kind: depth % 3 === 0 ? "turn" : depth % 3 === 1 ? "step" : "tool", label: String(depth), status: "queued", children: current ? [current] : undefined }
    expect(flattenTaskTree([current!])).toHaveLength(5)
  })

  it("keeps selection callback as the only action boundary", () => {
    const onSelect = vi.fn()
    const html = renderToStaticMarkup(<TaskTreePanel nodes={nodes} selectedId="turn-1" onSelect={onSelect} />)
    expect(html).toContain('aria-current="true"')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
