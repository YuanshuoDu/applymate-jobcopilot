import { DelayedError, type Job } from "bullmq"
import { SubagentLimitError, type SubagentJobPayload } from "../runtime/subagents/types.js"

const SUBAGENT_CONCURRENCY_DELAY_MS = 500

type DelayableSubagentJob = Pick<Job<SubagentJobPayload>, "moveToDelayed">

/** Re-schedules only a pre-claim session-capacity denial on the same locked Bull job. */
export async function runWithSubagentConcurrencyDeferral<TResult>(input: {
  job: DelayableSubagentJob
  token: string | undefined
  run: () => Promise<TResult>
}): Promise<TResult> {
  try {
    return await input.run()
  } catch (error: unknown) {
    if (!(error instanceof SubagentLimitError) || error.code !== "concurrency") throw error
    if (typeof input.token !== "string" || input.token.trim().length === 0) throw error
    await input.job.moveToDelayed(Date.now() + SUBAGENT_CONCURRENCY_DELAY_MS, input.token)
    throw new DelayedError()
  }
}
