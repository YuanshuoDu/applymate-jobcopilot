export type SubmissionPolicy = "review" | "autopilot";

export interface SubmissionPolicySettings {
  autoApply: boolean;
  requireApproval: boolean;
}

/** Both flags cannot describe autopilot: approval always wins for safety. */
export function submissionPolicy(settings: SubmissionPolicySettings): SubmissionPolicy {
  return settings.autoApply && !settings.requireApproval ? "autopilot" : "review";
}

export function submissionPolicyValues(policy: SubmissionPolicy): SubmissionPolicySettings {
  return policy === "autopilot"
    ? { autoApply: true, requireApproval: false }
    : { autoApply: false, requireApproval: true };
}

/** Restores the immutable policy captured when an automation session started. */
export function sessionSubmissionPolicy(events: readonly { type: string; data?: unknown }[]): SubmissionPolicy | null {
  const event = [...events].reverse().find(item => item.type === "automation_started");
  const data = event?.data;
  const payload = data && typeof data === "object" ? data as Record<string, unknown> : null;
  const nested = payload?.payload && typeof payload.payload === "object"
    ? payload.payload as Record<string, unknown>
    : payload;
  const automation = nested?.automation;
  if (!automation || typeof automation !== "object") return null;
  const settings = automation as Record<string, unknown>;
  if (typeof settings.autoApply !== "boolean" || typeof settings.requireApproval !== "boolean") return null;
  return submissionPolicy({ autoApply: settings.autoApply, requireApproval: settings.requireApproval });
}
