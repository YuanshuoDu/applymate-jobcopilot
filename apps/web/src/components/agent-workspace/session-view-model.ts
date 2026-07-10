export interface AgentSessionSummary {
  id: string
  goal: string
  status: string
  source: string
  memorySummary: string
  qualityScore: number | null
  currentTaskId: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface AgentTranscriptEvent {
  id: string
  taskId: string | null
  type: string
  speaker: string
  title: string | null
  body: string
  data: unknown | null
  durationMs: number | null
  createdAt: string
}

export interface AgentSessionDetail {
  id: string
  goal: string
  status: string
  source: string
  memorySummary: string
  qualityScore: number | null
  currentTaskId: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  tasks: Array<{
    id: string
    role: string
    taskType: string
    status: string
    confidence: number | null
    failureReason: string | null
    createdAt: string
    updatedAt: string
  }>
  approvals: Array<{
    id: string
    type: string
    status: string
    title: string
    createdAt: string
  }>
}

export function sessionStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    waiting_user: "Approval",
    completed: "Done",
    failed: "Failed",
    aborted: "Aborted",
  }
  return labels[status] ?? status
}

export function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    passed: "Passed",
    completed: "Done",
    failed: "Failed",
    retrying: "Retrying",
    waiting_for_user: "Waiting",
    skipped: "Skipped",
  }
  return labels[status] ?? status
}

export function taskStatusColor(status: string): string {
  if (status === "running") return "var(--primary)"
  if (status === "passed" || status === "completed") return "var(--c-success)"
  if (status === "failed") return "var(--c-danger)"
  if (status === "retrying" || status === "waiting_for_user") return "#d97706"
  return "var(--text-muted)"
}

export function confidenceLabel(confidence: number | null): string {
  return confidence == null ? "confidence pending" : `${Math.round(confidence * 100)}% confidence`
}

export function sessionSubtitle(session: Pick<AgentSessionSummary, "source" | "qualityScore" | "updatedAt">): string {
  const source = session.source === "manual_run" ? "Manual run" : session.source === "chat" ? "Chat" : session.source
  const score = session.qualityScore == null ? "quality pending" : `quality ${Math.round(session.qualityScore)}%`
  return `${source} · ${score} · ${formatSessionClock(session.updatedAt)}`
}

export function formatSessionClock(value: string, locale = "en"): string {
  return new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
}

export type EventTone = "user" | "orchestrator" | "subagent" | "approval" | "success" | "error" | "system"

export function eventChrome(type: string): { tone: EventTone; label: string } {
  if (type === "user_message") return { tone: "user", label: "You" }
  if (type === "approval_request") return { tone: "approval", label: "Approval required" }
  if (type === "approval_response") return { tone: "approval", label: "Approval response" }
  if (type === "automation_draft") return { tone: "orchestrator", label: "Automation draft" }
  if (type === "automation_started") return { tone: "orchestrator", label: "Automation started" }
  if (type === "automation_created") return { tone: "success", label: "Automation created" }
  if (type === "automation_updated") return { tone: "success", label: "Automation updated" }
  if (type === "automation_cancelled") return { tone: "system", label: "Automation cancelled" }
  if (type === "quality_gate") return { tone: "subagent", label: "Quality gate" }
  if (type === "final_report") return { tone: "success", label: "Final report" }
  if (type === "error") return { tone: "error", label: "Error" }
  if (type === "orchestrator_plan") return { tone: "orchestrator", label: "Plan" }
  if (type === "thinking_summary") return { tone: "orchestrator", label: "Thinking" }
  if (type === "session_memory") return { tone: "system", label: "Memory update" }
  if (type === "subagent_task_started") return { tone: "subagent", label: "Agent started" }
  if (type === "subagent_result") return { tone: "subagent", label: "Agent result" }
  if (type === "job_results") return { tone: "subagent", label: "Job result" }
  return { tone: "system", label: "System" }
}

export function shouldCollapseByDefault(type: string): boolean {
  return type === "thinking_summary"
}

export function eventSubtitle(
  event: Pick<AgentTranscriptEvent, "speaker" | "type" | "createdAt" | "durationMs">,
  locale = "en",
): string {
  const duration = event.durationMs == null ? "" : ` · ${(event.durationMs / 1000).toFixed(1)}s`
  return `${event.speaker} · ${eventChrome(event.type).label} · ${formatSessionClock(event.createdAt, locale)}${duration}`
}

export function approvalResponseIds(events: AgentTranscriptEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== "approval_response") continue
    if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) continue
    const approvalId = (event.data as { approvalId?: unknown }).approvalId
    if (typeof approvalId === "string" && approvalId) ids.add(approvalId)
  }
  return ids
}
