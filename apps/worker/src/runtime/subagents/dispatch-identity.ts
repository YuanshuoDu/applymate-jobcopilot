const JOB_PREFIX = "agent-subagent-"
const MAX_GENERATION = Number.MAX_SAFE_INTEGER - 1

export const SUBAGENT_DISPATCH_IDENTITY_MISMATCH = "dispatch_identity_mismatch" as const

export type SubagentDispatchIdentity = Readonly<{
  jobId: string
  taskId: string
  generation: number
}>

export function subagentDispatchJobId(taskId: string, generation = 0): string {
  if (typeof taskId !== "string" || !taskId.length || !Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION) {
    throw new RangeError("Invalid Subagent dispatch identity")
  }
  return `${JOB_PREFIX}${Buffer.from(taskId, "utf8").toString("base64url")}-${generation}`
}

/** Parses only the canonical task-bound ID format produced for BullMQ dispatches. */
export function parseSubagentDispatchJobId(value: unknown, expectedTaskId: string): SubagentDispatchIdentity | null {
  if (typeof value !== "string" || typeof expectedTaskId !== "string" || !expectedTaskId.length) return null
  const prefix = `${JOB_PREFIX}${Buffer.from(expectedTaskId, "utf8").toString("base64url")}-`
  if (!value.startsWith(prefix)) return null
  const generationText = value.slice(prefix.length)
  if (!/^(?:0|[1-9][0-9]*)$/.test(generationText)) return null
  const generation = Number(generationText)
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION) return null
  if (subagentDispatchJobId(expectedTaskId, generation) !== value) return null
  return { jobId: value, taskId: expectedTaskId, generation }
}

/** Revalidates the private in-process value against its immutable canonical ID. */
export function parseSubagentDispatchIdentity(value: unknown, expectedTaskId: string): SubagentDispatchIdentity | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.some(key => typeof key !== "string")
      || (ownKeys as string[]).sort().join(",") !== "generation,jobId,taskId") return null
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
    }
    const row = value as Record<string, unknown>, parsed = parseSubagentDispatchJobId(row.jobId, expectedTaskId)
    return parsed && row.taskId === parsed.taskId && row.generation === parsed.generation ? parsed : null
  } catch { return null }
}

export class SubagentDispatchIdentityMismatchError extends Error {
  readonly code = SUBAGENT_DISPATCH_IDENTITY_MISMATCH
  constructor() {
    super("Subagent dispatch identity mismatch")
    this.name = "SubagentDispatchIdentityMismatchError"
  }
}
