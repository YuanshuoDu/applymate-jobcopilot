import type { Page } from "playwright-core";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import {
  clickSubmit,
  fillCustomQuestions,
  getPersonaValue,
  tryFill,
  uploadResume,
  type FlowLogEntry,
} from "./helpers.js";

const SELECTORS = {
  firstName: [
    "input[name='first_name']",
    "#first_name",
    "input[placeholder*='first' i]",
  ],
  lastName: [
    "input[name='last_name']",
    "#last_name",
    "input[placeholder*='last' i]",
  ],
  email: [
    "input[type='email']",
    "input[name='email']",
  ],
  phone: [
    "input[type='tel']",
    "input[name='phone']",
  ],
  resume: [
    "input[type='file']",
  ],
  coverLetter: [
    "textarea[name*='cover' i]",
    "textarea[placeholder*='cover' i]",
    "textarea[placeholder*='message' i]",
    "textarea[placeholder*='additional' i]",
  ],
  submit: [
    "button[type='submit']",
    "button:has-text('Submit')",
    "button:has-text('Apply')",
    "input[type='submit']",
  ],
};

export async function runPersonioFlow(
  page: Page,
  task: ApplyTask
): Promise<HarnessResult> {
  const startedAt = Date.now();
  const log: FlowLogEntry[] = [];

  if (task.dryRun) {
    console.log("[personio-flow] Dry-run: skipping all fills and submit");
    return { status: "dry-run", turns: 1, durationMs: Date.now() - startedAt, log };
  }

  await tryFill(page, SELECTORS.firstName, getPersonaValue(task.persona, "firstName"), "firstName", log);
  await tryFill(page, SELECTORS.lastName, getPersonaValue(task.persona, "lastName"), "lastName", log);
  await tryFill(page, SELECTORS.email, task.persona.email ?? "", "email", log);
  await tryFill(page, SELECTORS.phone, task.persona.phone ?? "", "phone", log);

  if (task.resumePath && !task.resumePath.startsWith("db:")) {
    await uploadResume(page, SELECTORS.resume, task.resumePath, log);
  }

  if (task.persona.coverLetter) {
    await tryFill(page, SELECTORS.coverLetter, task.persona.coverLetter.slice(0, 2000), "coverLetter", log);
  }

  await fillCustomQuestions(page, task.persona, log);

  const submitted = await clickSubmit(page, SELECTORS.submit);
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
  const confirmed = /thank|success|confirmation|submitted|application.*received|vielen dank|bewerbung.*eingegangen/i.test(`${url} ${title}`);

  return {
    status: confirmed ? "submitted" : "manual",
    turns: 1,
    durationMs: Date.now() - startedAt,
    log,
  };
}
