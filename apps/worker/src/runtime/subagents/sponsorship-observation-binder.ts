import type pg from "pg"
import { toSponsorshipObservationPublicFrame } from "./sponsorship-observation-contract.js"
import {
  failedSponsorshipTaskObservations, isSponsorshipObservationTask, readSponsorshipTaskObservationsWithClient,
  sponsorshipCandidateJobIds, type SponsorshipObservationTask,
} from "./sponsorship-observation-binder-core.js"
import type { SponsorshipWaitObservation } from "../tools/coordination-types.js"

type Pool = Readonly<{ connect(): Promise<pg.PoolClient> }>
const GUIDANCE = "Use owner-scoped jobs.get for this Job. Sponsorship interpretation remains unverified without an independent same-role, same-country review bound to the exact source." as const

function publicFrames(observations: Awaited<ReturnType<typeof readSponsorshipTaskObservationsWithClient>>): readonly SponsorshipWaitObservation[] | undefined {
  return observations?.map(({ jobId, observation }) => ({ jobId, sourceRef: "saved_job_listing", observation: toSponsorshipObservationPublicFrame(observation), guidance: GUIDANCE }))
}

/** Rebinds completed Scout evidence from durable receipts and current owner-scoped Job rows. */
export async function readSponsorshipWaitObservations(pool: Pool, task: SponsorshipObservationTask): Promise<readonly SponsorshipWaitObservation[] | undefined> {
  if (!isSponsorshipObservationTask(task) || !sponsorshipCandidateJobIds(task)?.length) return undefined
  const fallback = failedSponsorshipTaskObservations(task)
  let client: pg.PoolClient
  try { client = await pool.connect() } catch { return publicFrames(fallback) }
  let transactionOpen = false
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transactionOpen = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [task.userId])
    const observations = await readSponsorshipTaskObservationsWithClient(client, task)
    await client.query("COMMIT"); transactionOpen = false
    return publicFrames(observations)
  } catch {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
    return publicFrames(fallback)
  } finally { client.release() }
}
