import type { Page } from "playwright-core";

export type FlowLogEntry = { field?: string; selector?: string; action: string };

export function getPersonaValue(persona: Record<string, string>, key: string): string {
  if (persona[key]) return persona[key];
  if (key === "firstName" && persona.fullName) return persona.fullName.trim().split(/\s+/)[0] ?? "";
  if (key === "lastName" && persona.fullName) {
    const parts = persona.fullName.trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : "";
  }
  return "";
}

export function normalizeLabel(value: string): string {
  return value.replace(/[-_[\]]/g, " ").toLowerCase().trim();
}

export function escapeSelectorValue(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"');
}

export async function humanType(page: Page, selector: string, value: string): Promise<void> {
  await page.fill(selector, "");
  for (const ch of value) {
    await page.type(selector, ch, { delay: 40 + Math.random() * 60 });
  }
}

export async function tryFill(
  page: Page,
  selectors: string[],
  value: string,
  field: string,
  log: FlowLogEntry[]
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

export async function uploadResume(
  page: Page,
  selectors: string[],
  filePath: string,
  log: FlowLogEntry[]
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

export async function fillCustomQuestions(
  page: Page,
  persona: Record<string, string>,
  log: FlowLogEntry[]
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

export async function clickSubmit(page: Page, selectors: string[]): Promise<boolean> {
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
