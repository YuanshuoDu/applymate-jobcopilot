import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { translate } from "@/lib/i18n"
import {
  handleTaskInterruptDialogKeydown,
  keepTaskInterruptDialogFocus,
  restoreTaskInterruptFocus,
  projectTaskInterruptView,
  taskInterruptEventVersion,
  taskInterruptKeyForVersion,
  TaskInterruptControl,
  TaskTreePanel,
  flattenTaskTree,
} from "./TaskTreePanel"
import type { TimelineItem } from "./timeline-reducer"
import type { TaskTreeNode } from "./types"

const nodes: TaskTreeNode[] = [{ id: "turn-1", kind: "turn", label: "Find Berlin roles", status: "running", itemId: "item-turn", children: [{ id: "step-1", kind: "step", label: "Scout jobs", status: "completed", itemId: "item-step", children: [{ id: "tool-1", kind: "tool", label: "jobs.search", status: "completed", itemId: "item-tool" }] }] }]

describe("TaskTreePanel", () => {
  it("renders Turn, Step, and Tool hierarchy", () => {
    const html = renderToStaticMarkup(<TaskTreePanel nodes={nodes} onSelect={vi.fn()} />)
    expect(html).toContain('data-agent-task-tree="true"')
    expect(html).toContain('data-task-tree-depth="2"')
    expect(html).toContain("jobs.search")
    expect(html).toContain(translate("en", "agent.step"))
    expect(html).not.toContain(translate("en", "agent.plan"))
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

  it("renders an accessible subtree confirmation and a nonterminal accepted status", () => {
    const control = (status: "accepted" | "interrupted" | "failed" | null, eligible = true) => <TaskInterruptControl
      sessionId="session-1" taskId="child-1" taskLabel="Research roles" eligible={eligible} status={status} statusVersion={status === "failed" ? "failure-1" : null} onAccepted={vi.fn()}
    />
    const ready = renderToStaticMarkup(control(null))
    expect(ready).toContain("Interrupt task and descendants")
    expect(ready).toContain('role="alertdialog"')
    expect(ready).toContain('aria-describedby="task-interrupt-scope"')
    expect(ready).toContain("Research roles and all descendants?")
    expect(ready).toContain("parent and unrelated siblings continue")
    expect(ready).toContain("siblings that depend on it may be cancelled by dependency rules")

    const accepted = renderToStaticMarkup(control("accepted", false))
    expect(accepted).toContain('role="status"')
    expect(accepted).toContain("Interrupt request accepted")
    expect(accepted).not.toContain("Task interrupted.")
    expect(accepted).not.toContain("Interrupt task and descendants")
    const failed = renderToStaticMarkup(control("failed"))
    expect(failed).toContain('role="alert"')
    expect(failed).toContain("Interrupt task and descendants")
    const interrupted = renderToStaticMarkup(control("interrupted", false))
    expect(interrupted).toContain("Task interrupted.")
    expect(interrupted).not.toContain("Interrupt task and descendants")
  })

  it("keeps local acceptance over only the same durable failure and preserves request-key idempotency", () => {
    const event = (id: string, eventType: string, sequence: string): TimelineItem => ({
      schemaVersion: "agent-harness.v2", id: `unknown:${id}`, sessionId: "session-1", turnId: "turn-1", stepId: null,
      taskId: "child-1", type: "unknown", status: "completed", phase: "commentary", revision: 0,
      content: { eventType, payload: {}, opaque: true }, startedAt: null, completedAt: null,
      createdAt: "2026-09-07T10:00:00.000Z", updatedAt: "2026-09-07T10:00:00.000Z", source: "unknown", sequence,
    })
    const staleFailure = event("failure-1", "task.interrupt.failed", "7")
    const newerFailure = event("failure-2", "task.interrupt.failed", "9")
    expect(taskInterruptEventVersion([newerFailure, staleFailure], "child-1")).toBe("failure-2")
    expect(projectTaskInterruptView(true, "failed", "failure-1", "failure-1")).toMatchObject({ visibleStatus: "accepted", showRetry: false })
    expect(projectTaskInterruptView(true, "failed", "failure-1", "failure-2")).toMatchObject({ visibleStatus: "failed", showRetry: true })
    expect(projectTaskInterruptView(true, "interrupted", "failure-1", "failure-1")).toMatchObject({ visibleStatus: "interrupted", showRetry: false })
    expect(projectTaskInterruptView(true, "failed", undefined, "failure-2", "failure-1").showRequestError).toBe(false)
    expect(projectTaskInterruptView(true, null, undefined, "failure-2", "failure-2").showRequestError).toBe(true)
    expect(projectTaskInterruptView(true, "failed", undefined, "failure-2", "failure-2")).toMatchObject({ visibleStatus: "failed", showRequestError: true })
    expect(projectTaskInterruptView(true, "accepted", undefined, "accepted-3", "failure-2").showRequestError).toBe(false)
    expect(projectTaskInterruptView(true, "interrupted", undefined, "interrupted-4", "failure-2").showRequestError).toBe(false)
    expect(projectTaskInterruptView(true, "accepted", undefined, "failure-2", "failure-2").showRequestError).toBe(false)
    expect(projectTaskInterruptView(true, "interrupted", undefined, "failure-2", "failure-2").showRequestError).toBe(false)
    const makeKey = vi.fn().mockReturnValueOnce("retry-1").mockReturnValueOnce("retry-2")
    const firstKey = taskInterruptKeyForVersion(null, "failure-1", makeKey)
    expect(taskInterruptKeyForVersion(firstKey, "failure-1", makeKey)).toBe(firstKey)
    expect(taskInterruptKeyForVersion(firstKey, "failure-2", makeKey)).toEqual({ id: "retry-2", statusVersion: "failure-2" })
    expect(makeKey).toHaveBeenCalledTimes(2)
  })

  it("dismisses the confirmation with Escape and traps Tab at both dialog boundaries", () => {
    let active: HTMLElement | null = null
    const makeFocusable = (): HTMLElement => {
      const element = { isConnected: true, focus: vi.fn(), closest: vi.fn(() => null), getAttribute: vi.fn(() => null) } as unknown as HTMLElement
      vi.mocked(element.focus).mockImplementation(() => { active = element })
      return element
    }
    const cancel = makeFocusable()
    const confirm = makeFocusable()
    const outside = makeFocusable()
    const dialog = {
      querySelectorAll: () => [cancel, confirm],
      contains: (target: Node | null) => target === cancel || target === confirm,
      focus: vi.fn(),
      ownerDocument: { get activeElement() { return active } },
    } as unknown as HTMLElement
    const key = (value: string, shiftKey = false) => ({
      key: value, shiftKey, preventDefault: vi.fn(),
    }) as unknown as KeyboardEvent
    const dismiss = vi.fn()

    active = cancel
    const backwards = key("Tab", true)
    handleTaskInterruptDialogKeydown(backwards, dialog, dismiss)
    expect(active).toBe(confirm)
    expect(backwards.preventDefault).toHaveBeenCalledOnce()

    active = confirm
    const forwards = key("Tab")
    handleTaskInterruptDialogKeydown(forwards, dialog, dismiss)
    expect(active).toBe(cancel)
    expect(forwards.preventDefault).toHaveBeenCalledOnce()

    active = outside
    const escaped = key("Escape")
    handleTaskInterruptDialogKeydown(escaped, dialog, dismiss)
    expect(dismiss).toHaveBeenCalledOnce()
    expect(escaped.preventDefault).toHaveBeenCalledOnce()
  })

  it("returns escaped focus to the dialog and restores focus to its trigger on close", () => {
    let active: HTMLElement | null = null
    const makeFocusable = (isConnected = true): HTMLElement => {
      const element = { isConnected, focus: vi.fn() } as unknown as HTMLElement
      vi.mocked(element.focus).mockImplementation(() => { active = element })
      return element
    }
    const cancel = makeFocusable()
    const outside = makeFocusable()
    const dialog = { contains: (target: Node | null) => target === cancel } as unknown as HTMLElement

    keepTaskInterruptDialogFocus(dialog, outside, cancel)
    expect(active).toBe(cancel)

    const trigger = makeFocusable()
    const fallback = makeFocusable()
    restoreTaskInterruptFocus(trigger, fallback)
    expect(active).toBe(trigger)
    restoreTaskInterruptFocus(makeFocusable(false), fallback)
    expect(active).toBe(fallback)
  })
})
