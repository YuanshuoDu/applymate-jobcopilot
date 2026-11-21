import type { Page } from "playwright-core";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import { clickSubmit, fillCustomQuestions, getPersonaValue, tryFill, uploadResume } from "./helpers.js";

/** Field map: try each selector in order, fill from persona if found */
const PERSONAL_FIELDS = [
  { selectors: ["#first_name", '[name*="first_name"]', '[name*="first"][type="text"]'], key: "firstName" },
  { selectors: ["#last_name",  '[name*="last_name"]',  '[name*="last"][type="text"]'],   key: "lastName"  },
  { selectors: ["#email",      '[name*="email"]',       '[type="email"]'],                key: "email"     },
  { selectors: ["#phone",      '[name*="phone"]',       '[type="tel"]'],                  key: "phone"     },
  { selectors: ['[name*="location"]', '[id*="location"]', '[placeholder*="ity"]'],        key: "location"  },
  { selectors: ['[name*="linkedin"]', '[id*="linkedin"]', '[placeholder*="inkedIn"]'],    key: "linkedinUrl" },
];

const RESUME_SELECTORS = [
  "#resume",
  "input[name*='resume' i][type='file']",
  "input[type='file']",
];

const COVER_LETTER_SELECTORS = [
  "textarea[name*='cover' i]",
  "textarea[id*='cover' i]",
  "textarea[placeholder*='cover' i]",
];

export async function runGreenhouseFlow(
  page: Page,
  task: ApplyTask,
  options?: { reviewedCoverLetter: string },
): Promise<HarnessResult> {
  const startedAt = Date.now();
  if (options && !validReviewedCoverLetter(options.reviewedCoverLetter, task.persona.coverLetter)) return { status: "manual", error: "Reviewed cover letter could not be safely filled.", durationMs: Date.now() - startedAt, reviewReady: false, log: [] };
  if (task.dryRun) {
    console.log("[greenhouse-flow] Dry-run: skipping all fills and submit");
    return { status: "dry-run", turns: 1, durationMs: Date.now() - startedAt, log: [] };
  }

  const log: Array<{ field?: string; selector?: string; action: string }> = [];
  let filled = 0;

  if (options && !await fillReviewedCoverLetter(page, options.reviewedCoverLetter, log)) {
    return { status: "manual", error: "Reviewed cover letter could not be safely filled.", durationMs: Date.now() - startedAt, reviewReady: false, log };
  }
  if (options) filled++;

  // Fill personal info fields
  for (const field of PERSONAL_FIELDS) {
    const value = getPersonaValue(task.persona, field.key);
    if (!value) continue;

    for (const sel of field.selectors) {
      try {
        const el = page.locator(sel).first();
        if (!(await el.count())) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;

        await page.fill(sel, "");
        for (const ch of value) {
          await page.type(sel, ch, { delay: 40 + Math.random() * 60 });
        }
        log.push({ field: field.key, selector: sel, action: "fill" });
        filled++;
        break;
      } catch {
        continue;
      }
    }
  }

  if (task.resumePath && !task.resumePath.startsWith("db:")) {
    if (await uploadResume(page, RESUME_SELECTORS, task.resumePath, log)) filled++;
  }

  if (!options && task.persona.coverLetter) {
    if (await tryFill(page, COVER_LETTER_SELECTORS, task.persona.coverLetter.slice(0, 2000), "coverLetter", log)) filled++;
  }

  // Sensitive custom questions are only filled from answers explicitly
  // confirmed for this application task, never from the shared Persona.
  await fillCustomQuestions(page, task.persona, log, task.confirmedAnswers);

  // Submit
  if (options || task.allowSubmit !== true) {
    return { status: "manual", turns: 1, error: "Form filled and ready for user review.", durationMs: Date.now() - startedAt, log, reviewReady: true };
  }
  const submitSelectors = [
    'input[type="submit"]',
    'button[type="submit"]',
    ".submit-button",
    "#submit-app",
  ];
  const submission = await clickSubmit(page, submitSelectors, task.beforeSubmit);
  if (submission.outcome === "blocked") {
    log.push({ field: submission.reason, selector: "submit", action: "submission_blocked" });
    return { status: "submission_blocked", turns: 1, error: submission.message, durationMs: Date.now() - startedAt, log };
  }
  if (submission.outcome === "missing") {
    return { status: "manual", error: "No submit button found", durationMs: Date.now() - startedAt, log };
  }

  const finalUrl = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {
    // best-effort
  }
  const confirmed = /thank|success|confirmation|submitted|application.*received/i.test(
    `${finalUrl} ${title}`
  );

  return {
    status: confirmed ? "submitted" : "manual",
    turns: 1,
    durationMs: Date.now() - startedAt,
    log,
  };
}

function validReviewedCoverLetter(content: string, personaValue: string | undefined): boolean {
  return content.length > 0 && content.length <= 2000 && content === personaValue;
}

async function fillReviewedCoverLetter(page: Page, content: string, log: Array<{ field?: string; selector?: string; action: string }>): Promise<boolean> {
  const selector = COVER_LETTER_SELECTORS.join(", ");
  try {
    const field = page.locator(selector);
    if (await field.count() !== 1 || !await field.isVisible() || await field.inputValue() !== "") return false;
    await field.fill(content);
    log.push({ field: "coverLetter", selector, action: "fill" });
    return true;
  } catch { return false; }
}
