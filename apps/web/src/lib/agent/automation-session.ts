export interface AutomationSessionRow {
  id: string
  goal: string
  status: string
  source: string
  memorySummary: string
  qualityScore: number | null
  currentTaskId: string | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

interface AutomationSessionDb {
  agentSession: {
    findFirst(args: { where: { id: string; userId: string } }): Promise<AutomationSessionRow | null>
    create(args: { data: Record<string, unknown> }): Promise<AutomationSessionRow>
    deleteMany(args: { where: { id: string; userId: string } }): Promise<{ count: number }>
  }
  agentAutomation: {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
    findFirst(args: { where: { id: string; userId: string }; select: { sessionId: true } }): Promise<{ sessionId: string | null } | null>
  }
}

export const ACTIVE_AUTOMATION_EXECUTION_STATUSES = ["queued", "running", "waiting_for_user", "paused"] as const

export function isActiveAutomationExecution(status: string | null | undefined) {
  return Boolean(status && ACTIVE_AUTOMATION_EXECUTION_STATUSES.includes(status as typeof ACTIVE_AUTOMATION_EXECUTION_STATUSES[number]))
}

export async function resolveAutomationSession(
  db: unknown,
  input: { automationId: string; userId: string; sessionId?: string | null; name: string; memorySummary?: string },
) {
  const store = db as AutomationSessionDb
  if (input.sessionId) {
    const existing = await store.agentSession.findFirst({ where: { id: input.sessionId, userId: input.userId } })
    if (existing) return { session: existing, created: false }
  }

  const created = await store.agentSession.create({
    data: {
      userId: input.userId,
      goal: `Run automation: ${input.name}`,
      source: "automation",
      status: "running",
      memorySummary: input.memorySummary ?? "Automation queued for execution.",
    },
  })
  const linked = await store.agentAutomation.updateMany({
    where: { id: input.automationId, userId: input.userId, sessionId: null },
    data: { sessionId: created.id },
  })
  if (linked.count === 1) return { session: created, created: true }

  // Another request won the link race. Remove only the unlinked row created by
  // this request, then return the canonical session owned by the automation.
  await store.agentSession.deleteMany({ where: { id: created.id, userId: input.userId } })
  const linkedAutomation = await store.agentAutomation.findFirst({
    where: { id: input.automationId, userId: input.userId },
    select: { sessionId: true },
  })
  if (!linkedAutomation?.sessionId) throw new Error("Could not resolve the automation session")
  const canonical = await store.agentSession.findFirst({ where: { id: linkedAutomation.sessionId, userId: input.userId } })
  if (!canonical) throw new Error("Could not load the automation session")
  return { session: canonical, created: false }
}
