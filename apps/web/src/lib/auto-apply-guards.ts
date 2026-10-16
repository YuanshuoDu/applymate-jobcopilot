import { db } from "@/lib/db";
import { assessApplicationPreflight, isSupportedAutomatedApplyUrl } from "@/lib/agent/application-preflight";
import { isRuntimeFeatureEnabled } from "@/lib/runtime-feature-flags";
import { isFeatureAllowed, resolveAiAccess } from "@/lib/entitlements";
import { requireLegacyPolicy } from "@/lib/agent/policy/legacy";

export class AutoApplyError extends Error {}

export function applicationFillTaskGraphEnabled(value = process.env.ENABLE_APPLICATION_FILL_TASKGRAPH): boolean {
  return value === "1";
}

export async function assertActiveAccount(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { accountStatus: true } });
  if (user?.accountStatus !== "active") throw new AutoApplyError("Account is not active.");
}

export async function assertUnattendedApplyEnabled(userId: string): Promise<void> {
  try {
    if (!await isFeatureAllowed(userId, "auto_apply")) throw new AutoApplyError("This feature is not included in your current plan.");
    const aiAccess = await resolveAiAccess(userId);
    if (aiAccess === "disabled") throw new AutoApplyError("This feature is not included in your current plan.");
    if (aiAccess === "exhausted") throw new AutoApplyError("Monthly AI credits exhausted.");
    if (!await isRuntimeFeatureEnabled("unattended_apply", userId)) {
      throw new AutoApplyError("Unattended applications are temporarily unavailable.");
    }
  } catch (error) {
    if (error instanceof AutoApplyError) throw error;
    throw new AutoApplyError("Unattended applications are temporarily unavailable.");
  }
}

export function validateAutoApplyUrl(rawUrl: string | null | undefined): string {
  const url = rawUrl?.trim();
  if (!url) throw new AutoApplyError("This job has no application URL.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AutoApplyError("The application URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new AutoApplyError("Automatic applications require an HTTPS destination.");
  }

  if (!isSupportedAutomatedApplyUrl(parsed.toString())) {
    throw new AutoApplyError("Automatic application requires a direct supported ATS link, not a job-board or unknown destination.");
  }

  return parsed.toString();
}

export async function assertJobPreflight(input: { userId: string; jobId: string }): Promise<void> {
  const job = await db.job.findFirst({
    where: { id: input.jobId, userId: input.userId },
    select: { company: true, description: true, source: true, url: true },
  });
  if (!job) throw new AutoApplyError("The job could not be found for application preflight.");
  try {
    requireLegacyPolicy({
      userId: input.userId, sessionId: `application-preflight:${input.jobId}`, turnId: `preflight:${input.jobId}`,
      stepId: "application.preflight", toolCallId: `preflight:${input.jobId}`, toolName: "application.preflight",
      domain: "application", risk: "read", capabilities: ["read"], input: { jobId: input.jobId, unknownSensitiveFacts: false },
    });
  } catch (error) {
    throw new AutoApplyError(error instanceof Error ? error.message : "Application preflight was denied by policy.");
  }
  const preflight = assessApplicationPreflight(job);
  if (!preflight.canAutomate) throw new AutoApplyError(preflight.issues.map(issue => issue.message).join(" "));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
