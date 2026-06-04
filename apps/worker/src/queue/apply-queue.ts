import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ApplyTaskPayload } from "@jobcopilot/shared";
import { checkRateLimit } from "../rate-limit.js";
import { withCloakContext } from "../cloak/pool.js";
import { insertApplyResult, getPool } from "../db/apply-results.js";
import { checkBudget, incrementBudget } from "../db/budget.js";
import { findFormPattern, recordPatternFailure } from "../db/form-patterns.js";
import { loadTaskContext } from "../db/load-task-context.js";
import { AgentHarness } from "../harness/agent-harness.js";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import { detectFlow } from "../flows/index.js";
import { runGreenhouseFlow } from "../flows/greenhouse-flow.js";
import { runWorkdayFlow } from '../flows/workday-flow.js'
import { runLeverFlow } from '../flows/lever-flow.js'
import { runPersonioFlow } from '../flows/personio-flow.js'
import { notifyApplyResult } from "../notifications/notify-apply-result.js";
import { shouldUsePattern } from "../patterns/confidence.js";
import { replayPattern } from "../patterns/replay.js";
import { unlinkSync } from "node:fs";

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
    let ctx: Awaited<ReturnType<typeof loadTaskContext>> | null = null;

    try {
      // Load real persona + job data from DB
      ctx = await loadTaskContext(getPool(), userId, jobId, applyUrl);
      const taskCtx = ctx; // non-null const for use inside async callbacks

      await Promise.race([
        withCloakContext(userId, async (page) => {
        console.log(
          `[apply-worker] Navigating to ${taskCtx.applyUrl} (user=${userId}, job=${jobId}, dryRun=${dryRun ?? false})`
        );

        await page.goto(taskCtx.applyUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        const applyTask: ApplyTask = {
          jobId,
          applyUrl: taskCtx.applyUrl,
          persona: {
            ...taskCtx.persona,
            coverLetter: taskCtx.coverLetterText ?? "",
          },
          jobTitle: taskCtx.jobTitle,
          jobCompany: taskCtx.jobCompany,
          jobKeywords: taskCtx.jobKeywords,
          resumePath: taskCtx.resumeTempPath ?? resumePath,
          coverLetterPath,
          dryRun: dryRun ?? false,
        };

        // Detect ATS → use pre-programmed flow if available, else AI fallback
        const flow = detectFlow(taskCtx.applyUrl);
        let harnessResult: HarnessResult;
        let usedFlow: string | null = flow ? "programmatic" : null;

        if (flow === "greenhouse") {
          console.log(`[apply-worker] Using Greenhouse pre-programmed flow`);
          harnessResult = await runGreenhouseFlow(page, applyTask);
        } else if (flow === "lever") {
          console.log(`[apply-worker] Using Lever pre-programmed flow`);
          harnessResult = await runLeverFlow(page, applyTask);
        } else if (flow === "workday") {
          console.log(`[apply-worker] Using Workday pre-programmed flow`);
          harnessResult = await runWorkdayFlow(page, applyTask);
        } else if (flow === "personio") {
          console.log(`[apply-worker] Using Personio pre-programmed flow`);
          harnessResult = await runPersonioFlow(page, applyTask);
        } else {
          // Phase 5: pattern cache -> replay -> AI fallback with budget cap.
          const budget = await checkBudget(userId);
          if (!budget.allowed) {
            console.log(`[apply-worker] AI budget exceeded: ${budget.used}/${budget.limit}`);
            harnessResult = {
              status: "manual",
              turns: 0,
              error: `AI fallback budget exceeded (${budget.used}/${budget.limit} this month)`,
              durationMs: 0,
              log: [],
            };
          } else {
            let host = "unknown";
            try { host = new URL(taskCtx.applyUrl).hostname; } catch { /* invalid URL: cache miss */ }
            const pathParts = taskCtx.applyUrl.replace(/^https?:\/\/[^/]+\//, "").split("/");
            const urlPattern = pathParts.slice(0, 2).join("/") + "/";

            const pattern = await findFormPattern(host, urlPattern).catch((e: Error) => {
              console.warn("[apply-worker] Pattern lookup failed:", e.message);
              return null;
            });

            if (pattern && shouldUsePattern(pattern)) {
              const attempts = pattern.successCount + pattern.failureCount;
              console.log(
                `[apply-worker] Pattern cache hit: ${host}/${urlPattern} (confidence=${pattern.successCount}/${attempts})`
              );
              harnessResult = await replayPattern(page, pattern, applyTask.persona);

              if (harnessResult.status !== "submitted") {
                await recordPatternFailure(pattern.id).catch((e: Error) =>
                  console.warn("[apply-worker] Pattern failure record failed:", e.message)
                );
                console.log("[apply-worker] Pattern replay failed, falling back to AgentHarness");
                usedFlow = "llm";
                const harness = new AgentHarness({
                  userId,
                  maxTurns: 30,
                  dryRun: dryRun ?? false,
                  mode: "dom",
                });
                harnessResult = await harness.run(page, applyTask);
                if (harnessResult.status === "submitted") {
                  await incrementBudget(userId).catch((e: Error) =>
                    console.warn("[apply-worker] Budget increment failed:", e.message)
                  );
                }
              } else {
                usedFlow = "pattern-cache";
              }
            } else {
              console.log(`[apply-worker] AI fallback: budget ${budget.used}/${budget.limit}`);
              usedFlow = "llm";
              const harness = new AgentHarness({
                userId,
                maxTurns: 30,
                dryRun: dryRun ?? false,
                mode: "dom",
              });
              harnessResult = await harness.run(page, applyTask);
              if (harnessResult.status === "submitted") {
                await incrementBudget(userId).catch((e: Error) =>
                  console.warn("[apply-worker] Budget increment failed:", e.message)
                );
              }
            }
          }
        }

        const durationMs = Date.now() - startedAt;
        await insertApplyResult({
          userId,
          jobId,
          status: harnessResult.status,
          mode: "unattended",
          atsType: flow ?? "unknown",
          flowUsed: usedFlow,
          error: harnessResult.error ?? null,
          durationMs,
        });
        resultWritten = true;

        // Send email notification (non-blocking, non-throwing)
        if (harnessResult.status !== 'dry-run') {
          notifyApplyResult({
            userId,
            jobTitle:   taskCtx.jobTitle,
            jobCompany: taskCtx.jobCompany,
            status:     harnessResult.status as 'submitted' | 'manual' | 'failed',
            error:      harnessResult.error ?? null,
            flowUsed:   flow ?? null,
            jobUrl:     taskCtx.applyUrl,
          }).catch((e: Error) => console.warn('[notify] email failed:', e.message))
        }

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
    } finally {
      // Clean up temp resume PDF to avoid accumulating files on disk
      if (ctx?.resumeTempPath) {
        try { unlinkSync(ctx.resumeTempPath!) } catch { /* ENOENT or already gone — ignore */ }
      }
    }
  },
  {
    connection,
    concurrency: Number(process.env.CLOAK_MAX_WORKERS ?? "1"),
  }
);


