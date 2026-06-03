import type { Page } from "playwright-core";
import type { FormPatternRow } from "../db/form-patterns.js";
import { clickSubmit, humanType } from "../flows/helpers.js";
import type { HarnessResult } from "../harness/agent-harness.js";

const SUBMIT_SELECTORS = [
  "button[type='submit']",
  "button:has-text('Submit')",
  "button:has-text('Apply')",
  "input[type='submit']",
];

const CONFIRMATION_REGEX = /thank|success|confirmation|submitted|application.*received/i;

type ReplayLogEntry = { field?: string; selector: string; action: string };

/**
 * Replay a cached form pattern by filling mapped fields and submitting.
 * This avoids the LLM perception-action loop when a known mapping exists.
 */
export async function replayPattern(
  page: Page,
  pattern: FormPatternRow,
  persona: Record<string, string>
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

  const submitted = await clickSubmit(page, SUBMIT_SELECTORS);
  if (!submitted) {
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
