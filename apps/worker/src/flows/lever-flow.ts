import type { Page } from "playwright-core";
import type { ApplyTask, HarnessResult } from "../harness/agent-harness.js";

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

// ?? Helpers ??????????????????????????????????????????????????????????????

async function tryFill(page: Page, selectors: string[], value: string, label: string) {
  if (!value) return false;
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      if (!(await el.isVisible().catch(() => false))) continue;

      // Clear existing + type with human delay
      await page.fill(sel, "");
      for (const ch of value) {
        await page.type(sel, ch, { delay: 40 + Math.random() * 60 });
      }
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function uploadResume(page: Page, selectors: string[], filePath: string) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.setInputFiles(filePath);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function fillCustomQuestions(page: Page, persona: Record<string, string>) {
  try {
    const handles = await page.$$("textarea:not([disabled]), input[type='text']:not([disabled])");
    for (const handle of handles) {
      try {
        const visible = await handle.isVisible().catch(() => false);
        if (!visible) continue;
        const currentVal = await handle.inputValue().catch(() => "");
        if (currentVal) continue;

        const nameAttr = (await handle.getAttribute("name")) ?? "";
        const idAttr   = (await handle.getAttribute("id"))   ?? "";
        const label    = nameAttr.replace(/[-_[\]]/g, " ").toLowerCase().trim();

        // Match against persona keys
        const matchKey = Object.keys(persona).find(
          (k) => label.includes(k.toLowerCase()) || k.toLowerCase().includes(label)
        );
        if (!matchKey || !persona[matchKey]) continue;

        const sel = idAttr
          ? `#${idAttr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
          : `[name="${nameAttr.replace(/"/g, '\\"')}"]`;

        const text = String(persona[matchKey]);
        for (const ch of text) {
          await page.type(sel, ch, { delay: 40 + Math.random() * 60 });
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Best-effort custom field scan
  }
}

async function clickLeverSubmit(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (!(await btn.count())) continue;
      if (!(await btn.isVisible().catch(() => false))) continue;
      await btn.click();
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

// ?? Main export ??????????????????????????????????????????????????????????

export async function runLeverFlow(
  page: Page,
  task: ApplyTask
): Promise<HarnessResult> {
  const startedAt = Date.now();
  const log: Array<{ field?: string; action: string }> = [];

  if (task.dryRun) {
    console.log("[lever-flow] Dry-run: skipping all fills and submit");
    return { status: "dry-run", turns: 1, durationMs: Date.now() - startedAt, log };
  }

  // 1. Personal info
  const filled: string[] = [];

  if (await tryFill(page, SELECTORS.name,  task.persona.fullName ?? task.persona.firstName ?? "", "name"))  filled.push("name");
  if (await tryFill(page, SELECTORS.email, task.persona.email ?? "", "email")) filled.push("email");
  if (await tryFill(page, SELECTORS.phone, task.persona.phone ?? "", "phone")) filled.push("phone");
  if (await tryFill(page, SELECTORS.linkedin, task.persona.linkedinUrl ?? "", "linkedin")) filled.push("linkedin");

  // 2. Resume upload
  if (task.resumePath && !task.resumePath.startsWith("db:")) {
    const uploaded = await uploadResume(page, SELECTORS.resume, task.resumePath);
    if (uploaded) log.push({ field: "resume", action: "upload" });
  }

  // 3. Cover letter
  if (task.persona.coverLetter) {
    const coverText = task.persona.coverLetter.slice(0, 2000);
    const filled = await tryFill(page, SELECTORS.coverLetter, coverText, "coverLetter");
    if (filled) log.push({ field: "coverLetter", action: "fill" });
  }

  // 4. Custom questions
  await fillCustomQuestions(page, task.persona);

  // 5. Submit
  const submitted = await clickLeverSubmit(page, SELECTORS.submit);
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
