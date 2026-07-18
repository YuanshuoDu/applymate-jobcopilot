import { describe, expect, it } from "vitest"
import {
  approvalResponseIds,
  eventChrome,
  eventSubtitle,
  formatSessionClock,
  confidenceLabel,
  EVENT_TONE_COLOR,
  sessionStatusLabel,
  sessionHeaderSubtitle,
  sessionSubtitle,
  shouldCollapseByDefault,
  taskStatusColor,
  taskStatusLabel,
} from "./session-view-model"

describe("agent session view model", () => {
  it("uses distinct colors for the user and the primary agent", () => {
    expect(EVENT_TONE_COLOR.user).toBe("#4F46E5")
    expect(EVENT_TONE_COLOR.orchestrator).toBe("#0F766E")
    expect(EVENT_TONE_COLOR.user).not.toBe(EVENT_TONE_COLOR.orchestrator)
  })

  it("labels session statuses for the left console", () => {
    expect(sessionStatusLabel("running")).toBe("Running")
    expect(sessionStatusLabel("waiting_user")).toBe("Approval")
    expect(sessionStatusLabel("completed")).toBe("Done")
    expect(sessionStatusLabel("failed")).toBe("Failed")
  })

  it("builds a compact session subtitle", () => {
    expect(sessionSubtitle({
      source: "manual_run",
      qualityScore: 83,
      updatedAt: "2026-06-18T09:42:00.000Z",
    })).toContain("Manual run")
    expect(sessionSubtitle({
      source: "chat",
      qualityScore: null,
      updatedAt: "2026-06-18T09:42:00.000Z",
    })).toContain("Chat")
  })

  it("builds a status-aware conversation header subtitle", () => {
    expect(sessionHeaderSubtitle({
      source: "chat",
      status: "completed",
      updatedAt: "2026-06-18T09:42:00.000Z",
    })).toContain("Done")
  })

  it("labels task status and confidence for the session focus panel", () => {
    expect(taskStatusLabel("running")).toBe("Running")
    expect(taskStatusLabel("waiting_for_user")).toBe("Waiting")
    expect(taskStatusColor("failed")).toBe("var(--c-danger)")
    expect(confidenceLabel(0.87)).toBe("87% confidence")
    expect(confidenceLabel(null)).toBe("confidence pending")
  })

  it("formats a stable message timestamp", () => {
    expect(formatSessionClock("2026-06-18T09:42:00.000Z", "en-GB")).toMatch(/09:42|10:42/)
  })

  it("gives approval and final events distinct chrome", () => {
    expect(eventChrome("approval_request").tone).toBe("approval")
    expect(eventChrome("final_report").tone).toBe("success")
  })

  it("labels automation result events distinctly", () => {
    expect(eventChrome("automation_started")).toEqual({ tone: "orchestrator", label: "Automation started" })
    expect(eventChrome("automation_created")).toEqual({ tone: "success", label: "Automation created" })
    expect(eventChrome("automation_updated")).toEqual({ tone: "success", label: "Automation updated" })
    expect(eventChrome("automation_cancelled").label).toBe("Automation cancelled")
  })

  it("labels typed session and subagent events", () => {
    expect(eventChrome("session_memory")).toEqual({ tone: "system", label: "Memory update" })
    expect(eventChrome("subagent_task_started")).toEqual({ tone: "subagent", label: "Agent started" })
  })

  it("collapses thinking summaries by default", () => {
    expect(shouldCollapseByDefault("thinking_summary")).toBe(true)
    expect(shouldCollapseByDefault("subagent_result")).toBe(false)
  })

  it("puts the time below the content through the subtitle helper", () => {
    expect(eventSubtitle({
      speaker: "Scout",
      type: "subagent_result",
      createdAt: "2026-06-18T09:42:00.000Z",
      durationMs: 1200,
    }, "en-GB")).toMatch(/Scout .* 1.2s/)
  })

  it("collects approval ids that already have a response event", () => {
    const ids = approvalResponseIds([
      event("approval_request", { id: "approval-1" }),
      event("approval_response", { approvalId: "approval-1", decision: "approved" }),
      event("approval_response", { approvalId: "" }),
      event("approval_response", null),
    ])

    expect([...ids]).toEqual(["approval-1"])
  })
})

function event(type: string, data: unknown) {
  return {
    id: `${type}-${Math.random()}`,
    taskId: null,
    type,
    speaker: "Orchestrator",
    title: null,
    body: "",
    data,
    durationMs: null,
    createdAt: "2026-06-18T09:42:00.000Z",
  }
}
