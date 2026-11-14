import type pg from "pg"

import type { ChildExecutorOptions } from "./child-executor.js"
import { loadChildSameAttemptContinuation } from "./child-mailbox-continuation.js"
import { loadChildAttemptResume } from "./child-resume.js"
import { repairConsumedChildWaitSources } from "./child-resume-consumed-wait-repair.js"
import { loadDurableSubagentWaitResume } from "./durable-subagent-wait-resume.js"

/** Installs legacy source repair before either production path reads consumed waits. */
export function createProductionChildResumeLoaders(pool: pg.Pool): Pick<ChildExecutorOptions, "resumeLoader" | "sameAttemptContinuationLoader"> {
  if (typeof (pool as unknown as { readonly connect?: unknown }).connect !== "function") return {}
  return {
    resumeLoader: async lease => {
      const now = new Date()
      await repairConsumedChildWaitSources(pool, lease, now)
      const wait = await loadDurableSubagentWaitResume(pool, lease, now)
      return loadChildAttemptResume(pool, lease, now, wait)
    },
    sameAttemptContinuationLoader: async lease => {
      const now = new Date()
      await repairConsumedChildWaitSources(pool, lease, now)
      return loadChildSameAttemptContinuation(pool, lease, now)
    },
  }
}
