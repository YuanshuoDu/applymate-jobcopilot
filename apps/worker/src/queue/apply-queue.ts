import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ApplyTaskPayload } from "@jobcopilot/shared";
import { checkRateLimit } from "../rate-limit.js";
import { withCloakContext } from "../cloak/pool.js";
import { insertApplyResult, getPool } from "../db/apply-results.js";
import { loadTaskContext } from "../db/load-task-context.js";
import { AgentHarness } from "../harness/agent-harness.js";
import type { ApplyTask } from "../harness/agent-harness.js";

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
      // Load real persona + job data from DB
      const ctx = await loadTaskContext(getPool(), userId, jobId, applyUrl);

      await withCloakContext(userId, async (page) => {
        console.log(
          `[apply-worker] Navigating to ${ctx.applyUrl} (user=${userId}, job=${jobId}, dryRun=${dryRun ?? false})`
        );

        await page.goto(ctx.applyUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        const harness = new AgentHarness({
          userId,
          maxTurns: 30,
          dryRun: dryRun ?? false,
          mode: "dom",
        });

        const applyTask: ApplyTask = {
          jobId,
          applyUrl: ctx.applyUrl,
          persona: ctx.persona,
          jobTitle: ctx.jobTitle,
          jobCompany: ctx.jobCompany,
          jobKeywords: ctx.jobKeywords,
          resumePath,
          coverLetterPath,
        };

        const harnessResult = await harness.run(page, applyTask);
        const durationMs = Date.now() - startedAt;

        await insertApplyResult({
          userId,
          jobId,
          status: harnessResult.status,
          mode: "unattended",
          error: harnessResult.error ?? null,
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
