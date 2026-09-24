/** Session statuses that still permit durable coordination and cleanup writes. */
export const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`

/** Compatibility name for open sessions that can accept new runtime work. */
export const RUNNABLE_SESSION = OPEN_SESSION
