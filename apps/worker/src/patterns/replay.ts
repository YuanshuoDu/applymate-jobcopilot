import type { Page } from "playwright-core";
import type { FormPatternRow } from "../db/form-patterns.js";
import { clickSubmit, humanType, type SubmissionGuard } from "../flows/helpers.js";
import type { HarnessResult } from "../harness/agent-harness.js";
import { createFormMappingArtifact } from "./form-pattern-artifact.js";

const SUBMIT_SELECTORS = [
  "button[type='submit']",
  "button:has-text('Submit')",
  "button:has-text('Apply')",
  "input[type='submit']",
];

const CONFIRMATION_REGEX = /thank|success|confirmation|submitted|application.*received/i;

type ReplayLogEntry = { field?: string; selector: string; action: string };

/**
 * Fill a cached pattern for review. This is the Agent/browser path: it has no
 * submit branch and therefore cannot be upgraded by model input or caller
 * options into an external write.
 */
export async function replayPatternForReview(
  page: Page,
  pattern: FormPatternRow,
  persona: Record<string, string>,
): Promise<HarnessResult> {
  const startedAt = Date.now();
  const log: ReplayLogEntry[] = [];
  let filled = 0;

  for (const [selector, personaKey] of Object.entries(pattern.fieldMapping)) {
    const value = persona[personaKey];
    if (!value) continue;
    try {
      const el = page.locator(selector).first();
      if (!(await el.count())) { log.push({ selector, action: "replay-miss" }); continue; }
      if (!(await el.isVisible().catch(() => false))) { log.push({ selector, action: "replay-hidden" }); continue; }
      await humanType(page, selector, String(value));
      log.push({ field: personaKey, selector, action: "replay-fill" });
      filled++;
    } catch {
      log.push({ selector, action: "replay-error" });
    }
  }

  const artifact = createFormMappingArtifact(pattern.fieldMapping, "pattern");
  if (filled === 0) {
    return { status: "manual", turns: 1, error: "No matching fields found in pattern", durationMs: Date.now() - startedAt, log, mappingArtifact: artifact };
  }
  return {
    status: "manual",
    turns: 1,
    error: "Form filled and ready for user review.",
    durationMs: Date.now() - startedAt,
    log,
    reviewReady: true,
    fieldMappings: { ...pattern.fieldMapping },
    mappingArtifact: artifact,
  };
}

/**
 * Replay a cached form pattern by filling mapped fields and submitting.
 * This avoids the LLM perception-action loop when a known mapping exists.
 */
export async function replayPattern(
  page: Page,
  pattern: FormPatternRow,
  persona: Record<string, string>,
  beforeSubmit?: SubmissionGuard,
): Promise<HarnessResult> {
  const startedAt = Date.now();
  const log: ReplayLogEntry[] = [];
  let filled = 0;

  for (const [selector, personaKey] of Object.entries(pattern.fieldMapping)) {
    const value = persona[personaKey];
    if (!value) continue;

    try {
      const el = page.locator(selector).first();
      if (!(await el.count())) {
        log.push({ selector, action: "replay-miss" });
        continue;
      }
      if (!(await el.isVisible().catch(() => false))) {
        log.push({ selector, action: "replay-hidden" });
        continue;
      }

      await humanType(page, selector, String(value));
      log.push({ field: personaKey, selector, action: "replay-fill" });
      filled++;
    } catch {
      log.push({ selector, action: "replay-error" });
    }
  }

  if (filled === 0) {
    return {
      status: "manual",
      turns: 1,
      error: "No matching fields found in pattern",
      durationMs: Date.now() - startedAt,
      log,
    };
  }

  const submission = await clickSubmit(page, SUBMIT_SELECTORS, beforeSubmit);
  if (submission.outcome === "blocked") {
    log.push({ field: submission.reason, selector: "submit", action: "submission_blocked" });
    return {
      status: "submission_blocked",
      turns: 1,
      error: submission.message,
      durationMs: Date.now() - startedAt,
      log,
    };
  }
  if (submission.outcome === "missing") {
    return {
      status: "manual",
      turns: 1,
      error: "Submit button not found",
      durationMs: Date.now() - startedAt,
      log,
    };
  }

  const url = page.url();
  const title = await page.title().catch(() => "");
  const confirmed = CONFIRMATION_REGEX.test(`${url} ${title}`);

  return {
    status: confirmed ? "submitted" : "manual",
    turns: 1,
    durationMs: Date.now() - startedAt,
    log,
  };
}
