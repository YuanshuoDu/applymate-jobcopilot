import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"

const path = "/api/internal/agent-runtime/scheduled-pipeline"
const blockedErrors = new Set(["scheduled_pipeline_owner_mismatch", "scheduled_pipeline_turn_stale", "scheduled_pipeline_mode_mismatch", "scheduled_pipeline_root_mismatch", "scheduled_pipeline_execution_mismatch", "scheduled_pipeline_attestation_invalid", "scheduled_pipeline_snapshot_mismatch", "scheduled_pipeline_discovery_incomplete", "scheduled_pipeline_jobs_mismatch", "scheduled_pipeline_claim_conflict", "scheduled_pipeline_analysis_interrupted", "scheduled_pipeline_request_invalid", "scheduled_pipeline_unauthorized", "scheduled_pipeline_account_unavailable", "scheduled_pipeline_entitlement_required", "scheduled_pipeline_ai_unavailable", "scheduled_pipeline_ai_budget_exhausted"])

export type ScheduledPipelineHandoff = { status: "completed" } | { status: "waiting_for_user"; waitId: string } | { status: "blocked"; errorCode: string }
type HandoffInput = { owner: ScheduledAutomationPipelineBridgeScope; attestation: ScheduledAutomationPipelineAttestation }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/** Authenticated server-to-server continuation; secrets remain in the header and are never serialized. */
export async function postScheduledPipelineContinuation(input: HandoffInput, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<ScheduledPipelineHandoff> {
  const base = process.env.AGENT_WEB_URL?.trim() || process.env.WEB_APP_URL?.trim() || process.env.APPLYMATE_WEB_URL?.trim(), secret = process.env.AGENT_WORKER_SECRET?.trim()
  if (!base || !secret || typeof fetcher !== "function") throw new Error("scheduled_pipeline_handoff_unavailable")
  const url = new URL(`${base.replace(/\/$/, "")}${path}`)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("scheduled_pipeline_handoff_unavailable")
  const response = await fetcher(url.toString(), { method: "POST", headers: { "content-type": "application/json", "x-agent-worker-secret": secret }, body: JSON.stringify(input), cache: "no-store", redirect: "error", signal })
  let payload: Record<string, unknown>
  try { payload = record(await response.json()) } catch { throw new Error("scheduled_pipeline_handoff_response_invalid") }
  if (response.status === 200 && payload.status === "completed" && validReport(payload.report)) return { status: "completed" }
  if (response.status === 202 && payload.status === "waiting_for_user" && validWaitId(payload.waitId)) return { status: "waiting_for_user", waitId: payload.waitId }
  const errorCode = payload.errorCode
  if (response.status >= 400 && response.status < 500 && payload.status === "blocked" && typeof errorCode === "string" && blockedErrors.has(errorCode)) return { status: "blocked", errorCode }
  throw new Error(response.status === 202 ? "scheduled_pipeline_handoff_in_progress" : "scheduled_pipeline_handoff_retryable")
}

function validReport(value: unknown): boolean {
  const report = record(value)
  return ["processed", "applied", "queued", "pending", "skipped", "failed", "durationMs"].every(key => Number.isSafeInteger(report[key]) && Number(report[key]) >= 0)
}

function validWaitId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}
