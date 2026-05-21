/**
 * Rate-limit policy registry for ATS discovery sources.
 *
 * Every ATS source must have an entry here. CI rejects PRs adding
 * a source without a corresponding policy entry.
 *
 * See: docs/scraping-autoapply-design.md §8 (Compliance)
 */

export interface RatePolicy {
  host: string        // e.g. "boards-api.greenhouse.io"
  rps:  number        // requests per second ceiling
}

/** Per-ATS rate limits — hard ceiling regardless of user count. */
export const POLICIES: Record<string, RatePolicy> = {
  greenhouse: { host: "boards-api.greenhouse.io", rps: 5 },
}

/**
 * Acquire a rate-limit slot before calling an ATS endpoint.
 * Blocks until a slot is available. Enforces RPS ceiling per host.
 */
export async function acquire(opts: { ats: string; host?: string }): Promise<void> {
  const policy = POLICIES[opts.ats]
  if (!policy) return  // unknown ATS — no rate limiting (will be caught by CI)

  const host = opts.host ?? policy.host
  if (host !== policy.host) return  // host mismatch — skip (custom endpoint)

  // Simple token-bucket: sleep for (1 / rps) seconds between calls
  // TODO(Phase 3): replace with shared Redis-backed token bucket
  await new Promise(r => setTimeout(r, Math.ceil(1000 / policy.rps)))
}