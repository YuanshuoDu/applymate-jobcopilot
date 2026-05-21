import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ApplyTaskPayload } from "@jobcopilot/shared";
import { checkRateLimit } from "../rate-limit.js";
import { withCloakContext } from "../cloak/pool.js";
import { insertApplyResult } from "../db/apply-results.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
export const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

export const QUEUE_NAME = "apply-tasks";

/** The queue used to enqueue apply tasks */
export const applyQueue = new Queue<ApplyTaskPayload>(QUEUE_NAME, {
  connection,
});

export const applyWorker = new Worker<ApplyTaskPayload>(
  QUEUE_NAME,
  async (job) => {
    const { userId, jobId, applyUrl, personaId, resumePath, coverLetterPath, dryRun } =
      job.data;

    // Extract domain from applyUrl for per-domain rate limiting
    let domain: string | null = null;
    try {
      const u = new URL(applyUrl);
      domain = u.hostname.replace(/^www\./, "");
    } catch {
      // Invalid URL — skip domain check
    }

    // Rate limit check
    const limit = checkRateLimit(userId, domain);
    if (!limit.allowed) {
      const retryMs = limit.retryAfterMs ?? 60_000;
      console.warn(
        `[apply-worker] Rate-limited: user=${userId} domain=${domain}, retry in ${retryMs}ms`
      );
      throw new Error(`RATE_LIMITED:${retryMs}`);
    }

    const startedAt = Date.now();

    try {
      await withCloakContext(userId, async (page) => {
        console.log(
          `[apply-worker] Navigating to ${applyUrl} (user=${userId}, job=${jobId}, dryRun=${dryRun ?? false})`
        );

        await page.goto(applyUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        // DRY-RUN mode: navigate but do NOT submit
        if (dryRun) {
          console.log(
            `[apply-worker] Dry-run: page loaded, not submitting (user=${userId}, job=${jobId})`
          );
          const durationMs = Date.now() - startedAt;
          await insertApplyResult({
            userId,
            jobId,
            status: "dry-run",
            mode: "unattended",
            durationMs,
          });
          return;
        }

        // --- PLACEHOLDER for Phase 4+ (pre-programmed flows) + Phase 5 (AI fallback) ---
        // In Phase 3, we only navigate and record. Actual form filling
        // will be added by #36 (AgentHarness) and future ATS flow modules.
        console.log(
          `[apply-worker] Page loaded. Form-fill not yet implemented (Phase 4-6). ` +
          `Recording as manual for user=${userId}, job=${jobId}`
        );

        const durationMs = Date.now() - startedAt;
        await insertApplyResult({
          userId,
          jobId,
          status: "manual",
          mode: "unattended",
          error: "Form fill not yet implemented (Phase 4-6)",
          durationMs,
        });
      });
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[apply-worker] Failed for user=${userId}, job=${jobId}: ${message}`
      );
      await insertApplyResult({
        userId,
        jobId,
        status: "failed",
        mode: "unattended",
        error: message,
        durationMs,
      });
      throw err;
    }
  },
  {
    connection,
    concurrency: Number(process.env.CLOAK_MAX_WORKERS ?? "1"),
  }
);
