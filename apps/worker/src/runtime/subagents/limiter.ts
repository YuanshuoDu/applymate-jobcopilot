import { SubagentLimitError, type SubagentPolicy } from "./types.js"

type SessionState = {
  running: Set<string>
}

export type SlotReservation = {
  readonly sessionId: string
  readonly taskId: string
  release(): void
}

/** Process-local fast path; the database store remains the cross-worker fence. */
export class SessionConcurrencyLimiter {
  private readonly sessions = new Map<string, SessionState>()

  reserve(sessionId: string, taskId: string, policy: SubagentPolicy): SlotReservation {
    if (!sessionId || !taskId) throw new TypeError("Session and task identifiers are required")
    const state = this.sessions.get(sessionId) ?? { running: new Set<string>() }
    if (state.running.has(taskId)) throw new Error(`Subagent slot is already reserved: ${taskId}`)
    if (state.running.size >= policy.maxConcurrency) {
      throw new SubagentLimitError("concurrency", `Session ${sessionId} reached its subagent concurrency limit`)
    }
    state.running.add(taskId)
    this.sessions.set(sessionId, state)
    let released = false
    return {
      sessionId,
      taskId,
      release: () => {
        if (released) return
        released = true
        state.running.delete(taskId)
        if (state.running.size === 0) this.sessions.delete(sessionId)
      },
    }
  }

  activeCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.running.size ?? 0
  }

  clear(): void {
    this.sessions.clear()
  }
}

