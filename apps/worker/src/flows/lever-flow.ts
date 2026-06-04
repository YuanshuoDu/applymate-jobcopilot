import type { Page } from "playwright-core";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";
import {
  clickSubmit,
  fillCustomQuestions,
  humanType,
  tryFill,
  uploadResume,
  type FlowLogEntry,
} from "./helpers.js";

/** Lever apply page selectors ? tried in order per field */
const SELECTORS = {
  name:        ["input[name='name']",         "input[placeholder*='name' i]"],
  email:       ["input[name='email']",        "input[type='email']"],
  phone:       ["input[name='phone']",        "input[type='tel']"],
  linkedin:    ["input[name*='LinkedIn' i]",  "input[placeholder*='LinkedIn' i]"],
  resume:      ["input[type='file']"],
  coverLetter: [
    "textarea[name='comments']",
    "textarea[placeholder*='cover' i]",
    "textarea[placeholder*='letter' i]",
    "textarea[placeholder*='additional' i]",
  ],
  submit:      ["button[type='submit'][data-qa='btn-submit-application']", "button[type='submit']"],
};

// ?? Main export ??????????????????????????????????????????????????????????

export async function runLeverFlow(
  page: Page,
  task: ApplyTask
): Promise<HarnessResult> {
  const startedAt = Date.now();
  const log: FlowLogEntry[] = [];

  if (task.dryRun) {
    console.log("[lever-flow] Dry-run: skipping all fills and submit");
    return { status: "dry-run", turns: 1, durationMs: Date.now() - startedAt, log };
  }

  // 1. Personal info
  await tryFill(page, SELECTORS.name, task.persona.fullName ?? task.persona.firstName ?? "", "name", log);
  await tryFill(page, SELECTORS.email, task.persona.email ?? "", "email", log);
  await tryFill(page, SELECTORS.phone, task.persona.phone ?? "", "phone", log);
  await tryFill(page, SELECTORS.linkedin, task.persona.linkedinUrl ?? "", "linkedin", log);

  // 2. Resume upload
  if (task.resumePath && !task.resumePath.startsWith("db:")) {
    await uploadResume(page, SELECTORS.resume, task.resumePath, log);
  }

  // 3. Cover letter
  if (task.persona.coverLetter) {
    const coverText = task.persona.coverLetter.slice(0, 2000);
    await tryFill(page, SELECTORS.coverLetter, coverText, "coverLetter", log);
  }

  // 4. Custom questions
  await fillCustomQuestions(page, task.persona, log);

  // 5. Submit
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

  // 6. Confirmation
  const url   = page.url();
  const title = await page.title().catch(() => "");
  const confirmed = /thank|success|confirmation|submitted|application.*received/i.test(
    `${url} ${title}`
  );

  return {
    status: confirmed ? "submitted" : "manual",
    turns: 1,
    durationMs: Date.now() - startedAt,
    log,
  };
}
