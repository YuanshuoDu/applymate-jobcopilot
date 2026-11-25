import { randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { FormReviewNeeds } from "../harness/form-review.js"
import { isFormAnswerKeyV2 } from "../form-answer-key.js"
import type { SubagentLease } from "../runtime/subagents/types.js"

export type FillWaitCheckpoint = "fill_outcome_uncertain" | "form_answer_required"
export type FillWaitDetail = "captcha_required" | "authentication_required" | "mfa_required" | "unknown_sensitive_field" | "required_field" | "stale_review" | "review_required" | "fill_outcome_uncertain" | "unattended_apply_unavailable" | "cancelled" | "browser_fill_failed"
export type FillWaitWriteStatus = "waiting" | "conflict"

const SAFE_DETAILS = new Set<FillWaitDetail>(["captcha_required", "authentication_required", "mfa_required", "unknown_sensitive_field", "required_field", "stale_review", "review_required", "fill_outcome_uncertain", "unattended_apply_unavailable", "cancelled", "browser_fill_failed"])

export function isFillWaitDetail(value: string): value is FillWaitDetail { return SAFE_DETAILS.has(value as FillWaitDetail) }

/** Writes a wait through an already owner-locked fill transaction. */
export async function writeApplicationFillWaitWithClient(
  client: Pick<PoolClient, "query">,
  input: { lease: SubagentLease; applicationTaskId: string; turnRevision: number; checkpoint: FillWaitCheckpoint; detail: FillWaitDetail; needs?: FormReviewNeeds; now: Date },
): Promise<FillWaitWriteStatus> {
  const needs = safeNeeds(input.needs), message = waitMessage(input.detail)
  const checkpoint: FillWaitCheckpoint = input.detail === "fill_outcome_uncertain" ? "fill_outcome_uncertain" : input.checkpoint
  const question = checkpoint === "form_answer_required" ? { waitId: randomUUID(), detail: message, missing: needs.missing, sensitive: needs.sensitive } : null
  const { lease } = input
  const updated = await client.query(`UPDATE "application_tasks" SET "status" = 'waiting_for_user', "checkpoint" = $4, "error" = $5,
      "question" = $6::jsonb, "updatedAt" = $7 WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
      AND "status" = 'filling' AND "checkpoint" = 'browser_active' RETURNING "id"`,
  [input.applicationTaskId, lease.userId, lease.sessionId, checkpoint, message, JSON.stringify(question), input.now])
  if (updated.rowCount !== 1) return "conflict"
  await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
      VALUES ($1, $2, $3, 'worker', $4, $5::jsonb, $6)`, [randomUUID(), input.applicationTaskId, checkpoint, message,
    JSON.stringify({ reason: input.detail, missingCount: needs.missing.length, sensitiveCount: needs.sensitive.length, turnId: lease.turnId, attemptCount: lease.attemptCount }), input.now])
  await client.query(`INSERT INTO "agent_transcript_events" ("id", "sessionId", "taskId", "type", "speaker", "title", "body", "data", "createdAt")
      VALUES ($1, $2, NULL, 'subagent_result', 'Executor', 'Application fill needs your attention', $3, $4::jsonb, $5)`,
  [randomUUID(), lease.sessionId, message, JSON.stringify({ applicationTaskId: input.applicationTaskId, checkpoint, turnId: lease.turnId }), input.now])
  const turnUpdate = await client.query(`UPDATE "agent_turns" SET "status" = 'waiting_for_user', "revision" = "revision" + 1,
      "completedAt" = NULL, "updatedAt" = $4 WHERE "id" = $1 AND "sessionId" = $2 AND "revision" = $3
      AND "status" IN ('in_progress', 'waiting_for_user', 'waiting_for_dependency') RETURNING "id"`, [lease.turnId, lease.sessionId, input.turnRevision, input.now])
  if (turnUpdate.rowCount !== 1) throw new Error("application_fill_wait_turn_conflict")
  await client.query(`UPDATE "agent_sessions" SET "status" = 'waiting_for_user', "completedAt" = NULL, "updatedAt" = $2 WHERE "id" = $1 AND "userId" = $3 AND "status" <> 'paused'`, [lease.sessionId, input.now, lease.userId])
  return "waiting"
}

function waitMessage(detail: FillWaitDetail): string {
  const messages: Record<FillWaitDetail, string> = {
    captcha_required: "A site challenge requires your action before the fill can continue.", authentication_required: "Sign in to the application site before the fill can continue.",
    mfa_required: "Complete the verification step before the fill can continue.", unknown_sensitive_field: "Review and confirm the sensitive application fields before the fill can continue.",
    required_field: "Provide the missing required application information before the fill can continue.", stale_review: "The application changed during review. Review the current form before continuing.",
    review_required: "Review the filled application before continuing.", fill_outcome_uncertain: "The browser stopped after starting the fill. This fill does not submit the application. Stop this Turn before requesting another fill attempt.",
    unattended_apply_unavailable: "Unattended form fill is unavailable. Review the application manually.", cancelled: "The application fill was cancelled.",
    browser_fill_failed: "The application form could not be filled. Review it manually before continuing.",
  }
  return messages[detail]
}

function safeNeeds(needs?: FormReviewNeeds): FormReviewNeeds {
  const clean = (fields: FormReviewNeeds["missing"] | undefined) => (fields ?? []).slice(0, 10).map(({ key, label }) => ({
    key: key && isFormAnswerKeyV2(key) ? key : null, label: redactSensitiveText(label).slice(0, 200),
  }))
  return { missing: clean(needs?.missing), sensitive: clean(needs?.sensitive) }
}
