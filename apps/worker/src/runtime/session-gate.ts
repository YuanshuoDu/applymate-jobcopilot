import type { SessionControlGate } from "@jobcopilot/agent-protocol"

/** Session statuses that still permit durable coordination and cleanup writes. */
export const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`

/** Session statuses plus the user gate required before starting new work. */
export const RUNNABLE_SESSION = `${OPEN_SESSION} AND session."controlGate" = 'open'`

export const SESSION_CONTROL_GATES = ["open", "user_paused"] as const satisfies readonly SessionControlGate[]

export function isSessionControlGate(value: unknown): value is SessionControlGate {
  return SESSION_CONTROL_GATES.includes(value as SessionControlGate)
}
