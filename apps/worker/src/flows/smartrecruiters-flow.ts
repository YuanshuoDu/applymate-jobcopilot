import type { Page } from "playwright-core";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";

const SELECTORS = {
  firstName: [
    "input[name='firstName']",
    "#firstName",
    "input[placeholder*='first' i]",
  ],
  lastName: [
    "input[name='lastName']",
    "#lastName",
    "input[placeholder*='last' i]",
  ],
  email: [
    "input[type='email']",
    "input[name='email']",
  ],
  phone: [
    "input[type='tel']",
    "input[name='phone']",
    "input[placeholder*='phone' i]",
  ],
  resume: [
    "input[type='file']",
  ],
  coverLetter: [
    "textarea[name*='cover' i]",
    "textarea[placeholder*='cover' i]",
    "textarea[placeholder*='letter' i]",
    "textarea[placeholder*='additional' i]",
    "textarea[placeholder*='message' i]",
  ],
  submit: [
    "button[type='submit']",
    "button:has-text('Submit')",
    "button:has-text('Apply')",
    "input[type='submit']",
  ],
};

type FlowLog = Array<{ field?: string; selector?: string; action: string }>;

function getPersonaValue(persona: Record<string, string>, key: string): string {
  if (persona[key]) return persona[key];
  if (key === "firstName" && persona.fullName) return persona.fullName.trim().split(/\s+/)[0] ?? "";
  if (key === "lastName" && persona.fullName) {
    const parts = persona.fullName.trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : "";
  }
  return "";
}

function normalizeLabel(value: string): string {
  return value.replace(/[-_[\]]/g, " ").toLowerCase().trim();
}

function escapeSelectorValue(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"');
}

async function humanType(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, "");
  for (const ch of value) {
    await page.type(selector, ch, { delay: 40 + Math.random() * 60 });
  }
}

async function tryFill(
  page: Page,
  selectors: string[],
  value: string,
  field: string,
  log: FlowLog
): Promise<boolean> {
  if (!value) return false;
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (!(await el.count())) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      const currentValue = await el.inputValue().catch(() => "");
      if (currentValue) return false;

      await humanType(page, selector, value);
      log.push({ field, selector, action: "fill" });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function uploadResume(
  page: Page,
  selectors: string[],
  filePath: string,
  log: FlowLog
): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (!(await el.count())) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.setInputFiles(filePath);
      log.push({ field: "resume", selector, action: "upload" });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function fillCustomQuestions(
  page: Page,
  persona: Record<string, string>,
  log: FlowLog
): Promise<void> {
  try {
    const handles = await page.$$("textarea:not([disabled]), input[type='text']:not([disabled])");
    for (const handle of handles) {
      try {
        if (!(await handle.isVisible().catch(() => false))) continue;
        if (await handle.inputValue().catch(() => "")) continue;

        const nameAttr = (await handle.getAttribute("name")) ?? "";
        const idAttr = (await handle.getAttribute("id")) ?? "";
        const label = normalizeLabel(`${nameAttr} ${idAttr}`);
        if (!label) continue;

        const matchKey = Object.keys(persona).find((key) => {
          const normalizedKey = normalizeLabel(key);
          return Boolean(
            normalizedKey &&
            persona[key] &&
            (label.includes(normalizedKey) || normalizedKey.includes(label))
          );
        });
        if (!matchKey) continue;

        const selector = idAttr
          ? `#${escapeSelectorValue(idAttr)}`
          : nameAttr
            ? `[name="${escapeSelectorValue(nameAttr)}"]`
            : null;
        if (!selector) continue;

        await humanType(page, selector, String(persona[matchKey]));
        log.push({ field: matchKey, selector, action: "fill-custom" });
      } catch {
        continue;
      }
    }
  } catch {
    // Best-effort custom field scan.
  }
}

async function clickSubmit(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const button = page.locator(selector).first();
      if (!(await button.count())) continue;
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click();
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function runSmartRecruitersFlow(
  page: Page,
  task: ApplyTask
): Promise<HarnessResult> {
  const startedAt = Date.now();
  const log: FlowLog = [];

  if (task.dryRun) {
    console.log("[smartrecruiters-flow] Dry-run: skipping all fills and submit");
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
  const confirmed = /thank|success|confirmation|submitted|application.*received/i.test(`${url} ${title}`);

  return {
    status: confirmed ? "submitted" : "manual",
    turns: 1,
    durationMs: Date.now() - startedAt,
    log,
  };
}
