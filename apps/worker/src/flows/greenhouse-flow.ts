import type { Page } from "playwright-core";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import { clickSubmit, fillCustomQuestions, getPersonaValue, isSubmissionAuthorized, tryFill, uploadResume } from "./helpers.js";

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
  task: ApplyTask
): Promise<HarnessResult> {
  const startedAt = Date.now();
  if (task.dryRun) {
    console.log("[greenhouse-flow] Dry-run: skipping all fills and submit");
    return { status: "dry-run", turns: 1, durationMs: Date.now() - startedAt, log: [] };
  }

  const log: Array<{ field?: string; selector?: string; action: string }> = [];
  let filled = 0;

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

  if (task.persona.coverLetter) {
    if (await tryFill(page, COVER_LETTER_SELECTORS, task.persona.coverLetter.slice(0, 2000), "coverLetter", log)) filled++;
  }

  // Sensitive custom questions are only filled from answers explicitly
  // confirmed for this application task, never from the shared Persona.
  await fillCustomQuestions(page, task.persona, log, task.confirmedAnswers);

  // Submit
  if (task.allowSubmit === false) {
    return { status: "manual", turns: 1, error: "Form filled and ready for user review.", durationMs: Date.now() - startedAt, log, reviewReady: true };
  }
  const submitSelectors = [
    'input[type="submit"]',
    'button[type="submit"]',
    ".submit-button",
    "#submit-app",
  ];
  const submission = await clickSubmit(page, submitSelectors, () => isSubmissionAuthorized(task));
  if (submission === 'blocked') {
    return { status: "manual", turns: 1, error: "Form filled and ready for user review.", durationMs: Date.now() - startedAt, log, reviewReady: true };
  }
  if (submission === 'missing') {
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
