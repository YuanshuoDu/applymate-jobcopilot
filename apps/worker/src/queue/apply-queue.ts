import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ApplyTaskPayload } from "@jobcopilot/shared";
import { checkRateLimit } from "../rate-limit.js";
import { withCloakContext } from "../cloak/pool.js";
import { detectCaptcha } from "../cloak/captcha.js";
import { insertApplyResult, getPool } from "../db/apply-results.js";
import {
  claimUnattendedSubmission,
  releaseUncertainSubmission,
  UNCONFIRMED_SUBMISSION_MESSAGE,
} from "../db/submission-guard.js";
import { checkBudget, incrementBudget } from "../db/budget.js";
import { findFormPattern, recordPatternFailure, upsertFormPattern } from "../db/form-patterns.js";
import { loadTaskContext } from "../db/load-task-context.js";
import { AgentHarness } from "../harness/agent-harness.js";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import { detectFlow } from "../flows/index.js";
import { runGreenhouseFlow } from "../flows/greenhouse-flow.js";
import { runWorkdayFlow } from '../flows/workday-flow.js'
import { runLeverFlow } from '../flows/lever-flow.js'
import { runPersonioFlow } from '../flows/personio-flow.js'
import { runSmartRecruitersFlow } from '../flows/smartrecruiters-flow.js'
import { createNotification } from "../notifications/create-notification.js";
import { notifyApplyResult } from "../notifications/notify-apply-result.js";
import { shouldUsePattern } from "../patterns/confidence.js";
import { replayPattern } from "../patterns/replay.js";
import { unlinkSync } from "node:fs";
import { claimApplicationTask, completeFillForReview, finishApplicationTask, needsUserTakeover, pauseForFormInput } from "../db/application-task-state.js";
import { formNeedsMessage, inspectFormReviewNeeds } from "../harness/form-review.js";
import { workerPollingOptions } from "./worker-polling-options.js";

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
    const { applicationTaskId, operation, userId, jobId, applyUrl, personaId, resumePath, coverLetterPath, dryRun } =
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
    const limit = await checkRateLimit(userId, domain);
    if (!limit.allowed) {
      const retryMs = limit.retryAfterMs ?? 60_000;
      console.warn(
        `[apply-worker] Rate-limited: user=${userId} domain=${domain}, retry in ${retryMs}ms`
      );
      throw new Error(`RATE_LIMITED:${retryMs}`);
    }

    const startedAt = Date.now();
    let resultWritten = false;
    let browserAttemptStarted = false;
    let ctx: Awaited<ReturnType<typeof loadTaskContext>> | null = null;

    try {
      if (!applicationTaskId || !operation || !await claimApplicationTask(getPool(), applicationTaskId, userId, jobId)) {
        console.warn(`[apply-worker] Skipping stale or revoked application task for job=${jobId}`);
        return;
      }
      // Load real persona + job data from DB
      ctx = await loadTaskContext(getPool(), userId, jobId, applyUrl, applicationTaskId);
      const taskCtx = ctx; // non-null const for use inside async callbacks

      await Promise.race([
        withCloakContext(userId, async (page) => {
        if (operation === "submit") {
          const submissionClaim = await claimUnattendedSubmission(getPool(), userId, jobId);
          if (submissionClaim === "unavailable") {
            console.warn(`[apply-worker] Skipping duplicate task for job=${jobId}; it is no longer queued.`);
            return;
          }

          if (submissionClaim === "uncertain") {
            await insertApplyResult({
              userId, jobId, status: "manual", mode: "unattended", atsType: null, flowUsed: null,
              error: UNCONFIRMED_SUBMISSION_MESSAGE, durationMs: Date.now() - startedAt,
            });
            resultWritten = true;
            await finishApplicationTask(getPool(), applicationTaskId, "waiting_for_user", "submission_uncertain", UNCONFIRMED_SUBMISSION_MESSAGE);
            createApplyResultNotification({ userId, jobId, jobTitle: taskCtx.jobTitle, jobCompany: taskCtx.jobCompany, status: "manual" })
              .catch((e: Error) => console.warn("[notify] in-app notification failed:", e.message));
            return;
          }
        }

        browserAttemptStarted = true;
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
          allowSubmit: operation === "submit",
          confirmedAnswers: taskCtx.confirmedAnswers,
        };

        // Detect ATS → use pre-programmed flow if available, else AI fallback
        const flow = detectFlow(taskCtx.applyUrl);
        let harnessResult: HarnessResult | null = null;
        let usedFlow: string | null = flow ? "programmatic" : null;

        const hasCaptcha = await detectCaptcha(page).catch(() => false);
        if (hasCaptcha) {
          // CAPTCHA, login and MFA are explicit human handoff boundaries.
          // Do not use third-party solvers or attempt to bypass platform controls.
          console.log("[apply-worker] CAPTCHA detected; requesting user takeover.");
          harnessResult = {
            status: "manual",
            turns: 0,
            error: "CAPTCHA detected. User takeover is required; no bypass was attempted.",
            durationMs: 0,
            log: [],
          };
          usedFlow = null;
        }

        if (harnessResult) {
          // CAPTCHA branch already decided the outcome.
        } else if (flow === "greenhouse") {
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
        } else if (flow === "smartrecruiters") {
          console.log(`[apply-worker] Using SmartRecruiters pre-programmed flow`);
          harnessResult = await runSmartRecruitersFlow(page, applyTask);
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

            if (operation === "submit" && pattern && shouldUsePattern(pattern)) {
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
                  writeFormPattern(taskCtx.applyUrl, harnessResult);
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
                writeFormPattern(taskCtx.applyUrl, harnessResult);
              }
            }
          }
        }

        if (!harnessResult) {
          throw new Error("Apply completed without a harness result");
        }

        if (operation === "fill" && harnessResult.reviewReady) {
          const needs = await inspectFormReviewNeeds(page);
          const needMessage = formNeedsMessage(needs);
          if (needMessage) {
            await insertApplyResult({ userId, jobId, status: "manual", mode: "unattended", atsType: flow ?? "unknown", flowUsed: usedFlow, error: needMessage, durationMs: Date.now() - startedAt });
            resultWritten = true;
            await pauseForFormInput(getPool(), applicationTaskId, needMessage, needs);
            createApplyResultNotification({ userId, jobId, jobTitle: taskCtx.jobTitle, jobCompany: taskCtx.jobCompany, status: "manual" })
              .catch((e: Error) => console.warn("[notify] in-app notification failed:", e.message));
            return;
          }
          await insertApplyResult({
            userId, jobId, status: "manual", mode: "unattended", atsType: flow ?? "unknown", flowUsed: usedFlow,
            error: harnessResult.error ?? "Form filled and ready for user review.", durationMs: Date.now() - startedAt,
          });
          resultWritten = true;
          const reviewReady = await completeFillForReview(getPool(), applicationTaskId, userId, jobId);
          if (!reviewReady) return;
          createApplyResultNotification({ userId, jobId, jobTitle: taskCtx.jobTitle, jobCompany: taskCtx.jobCompany, status: "manual" })
            .catch((e: Error) => console.warn("[notify] in-app notification failed:", e.message));
          return;
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

        if (
          harnessResult.status === "submitted" ||
          harnessResult.status === "manual" ||
          harnessResult.status === "failed"
        ) {
          createApplyResultNotification({
            userId,
            jobId,
            jobTitle: taskCtx.jobTitle,
            jobCompany: taskCtx.jobCompany,
            status: harnessResult.status,
          }).catch((e: Error) => console.warn("[notify] in-app notification failed:", e.message));
        }

        // Send email notification (non-blocking, non-throwing)
        if (harnessResult.status !== 'dry-run') {
          notifyApplyResult({
            userId,
            jobTitle:   taskCtx.jobTitle,
            jobCompany: taskCtx.jobCompany,
            status:     harnessResult.status as 'submitted' | 'manual' | 'failed',
            error:      harnessResult.error ?? null,
            flowUsed:   usedFlow,
            jobUrl:     taskCtx.applyUrl,
          }).catch((e: Error) => console.warn('[notify] email failed:', e.message))
        }

        // Update Job status based on actual outcome
        const isSubmitted = harnessResult.status === 'submitted';
        const newJobStatus = isSubmitted ? 'applied' : 'saved';
        const newWorkflowState = isSubmitted ? 'submitted' : 'ready_to_apply';

        await getPool().query(
          'UPDATE "Job" SET status = $1, "workflowState" = $2, "appliedAt" = CASE WHEN $1 = \'applied\' THEN NOW() ELSE "appliedAt" END, "updatedAt" = NOW() WHERE id = $3 AND "userId" = $4',
          [newJobStatus, newWorkflowState, jobId, userId]
        )
        const requiresUserTakeover = harnessResult.status === "manual" || needsUserTakeover(harnessResult.error);
        await finishApplicationTask(
          getPool(),
          applicationTaskId,
          isSubmitted ? "submitted" : requiresUserTakeover ? "waiting_for_user" : "failed",
          isSubmitted ? "submission_verified" : requiresUserTakeover ? "user_takeover" : "execution_failed",
          harnessResult.error ?? null,
        );

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
        const status = browserAttemptStarted ? "manual" : "failed";
        const safeMessage = browserAttemptStarted
          ? `${UNCONFIRMED_SUBMISSION_MESSAGE} Original error: ${message}`
          : message;
        await insertApplyResult({
          userId,
          jobId,
          status,
          mode: "unattended",
          atsType: null,
          flowUsed: null,
          error: safeMessage,
          durationMs,
        });
        if (browserAttemptStarted) {
          await releaseUncertainSubmission(getPool(), userId, jobId);
        } else {
          await getPool().query(
            'UPDATE "Job" SET status = $1, "workflowState" = $2, "updatedAt" = NOW() WHERE id = $3 AND "userId" = $4',
            ['saved', 'ready_to_apply', jobId, userId]
          );
        }
        createApplyResultNotification({
          userId,
          jobId,
          jobTitle: ctx?.jobTitle ?? null,
          jobCompany: ctx?.jobCompany ?? "Application",
          status,
        }).catch((e: Error) => console.warn("[notify] in-app notification failed:", e.message));
      }
      if (applicationTaskId) {
        await finishApplicationTask(
          getPool(),
          applicationTaskId,
          browserAttemptStarted ? "waiting_for_user" : "failed",
          browserAttemptStarted ? "execution_interrupted" : "worker_failed",
          message,
        ).catch((stateError: Error) => console.warn("[apply-worker] Could not persist task failure:", stateError.message));
      }
      // Once a browser has started, BullMQ must not replay the task. A form
      // submit may have reached the ATS even when the worker lost its result.
      // Fail-safe review is preferable to an accidental duplicate application.
      return;
    } finally {
      // Clean up temp resume PDF to avoid accumulating files on disk
      if (ctx?.resumeTempPath) {
        try { unlinkSync(ctx.resumeTempPath!) } catch { /* ENOENT or already gone — ignore */ }
      }
    }
  },
  {
    connection,
    ...workerPollingOptions(),
    concurrency: Number(process.env.CLOAK_MAX_WORKERS ?? "1"),
  }
);

async function createApplyResultNotification(params: {
  userId: string;
  jobId: string;
  jobTitle: string | null;
  jobCompany: string;
  status: "submitted" | "manual" | "failed";
}): Promise<void> {
  await createNotification(params.userId, {
    type: notificationTypeForStatus(params.status),
    title: notificationTitle(params.jobCompany, params.status),
    body: params.jobTitle,
    jobId: params.jobId,
  });
}

function writeFormPattern(applyUrl: string, harnessResult: HarnessResult): void {
  if (!harnessResult.fieldMappings || Object.keys(harnessResult.fieldMappings).length === 0) {
    return;
  }

  let host = "unknown";
  try { host = new URL(applyUrl).hostname; } catch { /* invalid URL: write unknown host */ }
  const pathParts = applyUrl.replace(/^https?:\/\/[^/]+\//, "").split("/");
  const urlPattern = pathParts.slice(0, 2).join("/") + "/";

  upsertFormPattern({
    atsHost: host,
    urlPattern,
    fieldMapping: harnessResult.fieldMappings,
  }).catch((e: Error) => console.warn("[apply-worker] Pattern write failed:", e.message));
}

function notificationTypeForStatus(
  status: "submitted" | "manual" | "failed"
): "apply_submitted" | "apply_manual" | "apply_failed" {
  return status === "submitted"
    ? "apply_submitted"
    : status === "manual"
      ? "apply_manual"
      : "apply_failed";
}

function notificationTitle(company: string, status: "submitted" | "manual" | "failed"): string {
  return status === "submitted"
    ? `${company} ✅`
    : status === "manual"
      ? `${company} ⚠️`
      : `${company} ❌`;
}


