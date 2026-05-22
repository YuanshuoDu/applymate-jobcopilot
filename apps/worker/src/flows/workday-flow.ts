import type { Page } from "playwright-core";
import type { ApplyTask } from "../harness/agent-harness.js";
import type { HarnessResult } from "../harness/agent-harness.js";

const SELECTORS = {
  // Step 1 — Personal info
  firstName:  ['[data-automation-id="legalNameSection_firstName"]', '[aria-label*="First Name"]'],
  lastName:   ['[data-automation-id="legalNameSection_lastName"]', '[aria-label*="Last Name"]'],
  email:      ['[data-automation-id="email"]', '[type="email"]'],
  phone:      ['[data-automation-id="phone"]', '[type="tel"]'],

  // Step 2 — Resume
  resumeUpload: ['input[type="file"]', '[data-automation-id="file-upload-input"]'],

  // Navigation
  nextBtn:    ['[data-automation-id="nextButton"]', 'button[aria-label="Next"]', '.next-button'],
  submitBtn:  ['[data-automation-id="bottom-navigation-next-button"]', 'button[aria-label="Submit"]'],
};

export async function runWorkdayFlow(page: Page, task: ApplyTask): Promise<HarnessResult> {
  const startedAt = Date.now();
  if (task.dryRun) return { status: "dry-run", turns: 1, durationMs: Date.now() - startedAt, log: [] };

  const log: unknown[] = [];
  let step = 1;

  try {
    // Step 1: My Information
    await fillField(page, SELECTORS.firstName, task.persona.firstName ?? task.persona.fullName?.split(" ")[0] ?? "");
    await fillField(page, SELECTORS.lastName,  task.persona.lastName  ?? task.persona.fullName?.split(" ").slice(1).join(" ") ?? "");
    await fillField(page, SELECTORS.email,     task.persona.email ?? "");
    await fillField(page, SELECTORS.phone,     task.persona.phone ?? "");
    await clickNext(page, SELECTORS.nextBtn);
    log.push({ step: 1, action: "personal info filled" });
    step = 2;

    // Step 2: My Experience — resume upload
    if (task.resumePath && !task.resumePath.startsWith("db:")) {
      await uploadFile(page, SELECTORS.resumeUpload, task.resumePath);
      log.push({ step: 2, action: "resume uploaded" });
    }
    await clickNext(page, SELECTORS.nextBtn);
    step = 3;

    // Step 3: Application Questions — fill visible text inputs with persona data
    await fillCustomQuestions(page, task.persona);
    await clickNext(page, SELECTORS.nextBtn);
    step = 4;

    // Step 4: Voluntary — skip (click next without filling)
    await page.waitForTimeout(1000);
    await clickNext(page, SELECTORS.nextBtn);
    step = 5;

    // Step 5: Review & Submit
    await page.waitForTimeout(2000);
    for (const sel of SELECTORS.submitBtn) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        break;
      }
    }

    const url = page.url();
    const title = await page.title().catch(() => "");
    const confirmed = /thank|success|confirmation|submitted/i.test(url + " " + title);
    return { status: confirmed ? "submitted" : "manual", turns: step, durationMs: Date.now() - startedAt, log };

  } catch (err) {
    return {
      status: "manual",
      turns: step,
      error: `Workday flow failed at step ${step}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startedAt,
      log,
    };
  }
}

async function fillField(page: Page, selectors: string[], value: string): Promise<void> {
  if (!value) return;
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.fill("");
      for (const ch of value) await page.keyboard.type(ch, { delay: 40 + Math.random() * 60 });
      return;
    }
  }
}

async function uploadFile(page: Page, selectors: string[], path: string): Promise<void> {
  for (const sel of selectors) {
    try {
      await page.setInputFiles(sel, path);
      return;
    } catch { continue; }
  }
}

async function clickNext(page: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      return;
    }
  }
}

async function fillCustomQuestions(page: Page, persona: Record<string, string>): Promise<void> {
  const fields = await page.locator('input[type="text"]:not([disabled]), textarea:not([disabled])').all();
  for (const field of fields) {
    if (!await field.isVisible().catch(() => false)) continue;
    const current = await field.inputValue().catch(() => "");
    if (current) continue; // already filled
    const label = await field.evaluate((el) => {
      const id = (el as HTMLInputElement).getAttribute("aria-labelledby") || el.id;
      const lbl = id ? document.getElementById(id) : el.closest("label");
      return (lbl?.textContent ?? (el as HTMLInputElement).getAttribute("aria-label") ?? "").trim().toLowerCase();
    });
    const key = Object.keys(persona).find((k) =>
      label.includes(k.toLowerCase()) || k.toLowerCase().includes(label)
    );
    if (key && persona[key]) await field.fill(persona[key]);
  }
}


