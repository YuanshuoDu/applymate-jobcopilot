import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ApplyTaskPayload } from "@jobcopilot/shared";
import { checkRateLimit } from "../rate-limit.js";
import { withCloakContext } from "../cloak/pool.js";
import { insertApplyResult, getPool } from "../db/apply-results.js";
import { loadTaskContext } from "../db/load-task-context.js";
import { AgentHarness } from "../harness/agent-harness.js";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import { detectFlow } from "../flows/index.js";
import { runGreenhouseFlow } from "../flows/greenhouse-flow.js";
import { runWorkdayFlow } from "../flows/workday-flow.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
export const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const APPLY_TIMEOUT_MS = Number(process.env.APPLY_TIMEOUT_MS ?? '300000');

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
    let resultWritten = false;

    try {
      // Load real persona + job data from DB
      const ctx = await loadTaskContext(getPool(), userId, jobId, applyUrl);

      await Promise.race([
        withCloakContext(userId, async (page) => {
        console.log(
          `[apply-worker] Navigating to ${ctx.applyUrl} (user=${userId}, job=${jobId}, dryRun=${dryRun ?? false})`
        );

        await page.goto(ctx.applyUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        const applyTask: ApplyTask = {
          jobId,
          applyUrl: ctx.applyUrl,
          persona: {
            ...ctx.persona,
            coverLetter: ctx.coverLetterText ?? "",
          },
          jobTitle: ctx.jobTitle,
          jobCompany: ctx.jobCompany,
          jobKeywords: ctx.jobKeywords,
          resumePath: ctx.resumeTempPath ?? resumePath,
          coverLetterPath,
          dryRun: dryRun ?? false,
        };

        // Detect ATS → use pre-programmed flow if available, else AI fallback
        const flow = detectFlow(ctx.applyUrl);
        let harnessResult: HarnessResult;

        if (flow === "greenhouse") {
          console.log(`[apply-worker] Using Greenhouse pre-programmed flow`);
          harnessResult = await runGreenhouseFlow(page, applyTask);
        } else if (flow === "workday") {
          console.log(`[apply-worker] Using Workday pre-programmed flow`);
          harnessResult = await runWorkdayFlow(page, applyTask);
        } else {
          const harness = new AgentHarness({
            userId,
            maxTurns: 30,
            dryRun: dryRun ?? false,
            mode: "dom",
          });
          harnessResult = await harness.run(page, applyTask);
        }

        const durationMs = Date.now() - startedAt;
        await insertApplyResult({
          userId,
          jobId,
          status: harnessResult.status,
          mode: "unattended",
          atsType: flow ?? "unknown",
          flowUsed: flow ? "programmatic" : "llm",
          error: harnessResult.error ?? null,
          durationMs,
        });
        resultWritten = true;

        // Update Job status based on actual outcome
        const newJobStatus =
          harnessResult.status === 'submitted' ? 'applied' :
          harnessResult.status === 'failed'    ? 'saved'   :
          'applied';  // manual → keep applied

        await getPool().query(
          'UPDATE "Job" SET status = $1, "updatedAt" = NOW() WHERE id = $2 AND "userId" = $3',
          [newJobStatus, jobId, userId]
        )

        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Apply timeout: exceeded 5 minutes')), APPLY_TIMEOUT_MS)
        ),
      ]);
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[apply-worker] Failed for user=${userId}, job=${jobId}: ${message}`
      );

      if (!resultWritten) {
        await insertApplyResult({
          userId,
          jobId,
          status: "failed",
          mode: "unattended",
          atsType: null,
          flowUsed: null,
          error: message,
          durationMs,
        });
        await getPool().query(
          'UPDATE "Job" SET status = $1, "updatedAt" = NOW() WHERE id = $2 AND "userId" = $3',
          ['saved', jobId, userId]
        );
      }
      throw err;
    }
  },
  {
    connection,
    concurrency: Number(process.env.CLOAK_MAX_WORKERS ?? "1"),
  }
);


