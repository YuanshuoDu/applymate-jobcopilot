import type { Page } from "playwright-core";

export interface FormReviewNeeds {
  missing: string[];
  sensitive: string[];
}

const SENSITIVE = /salary|compensation|pay|visa|sponsor|work.?authori[sz]|citizen|nationality|legal|criminal|disability|gender|race|ethnic|signature|e-?sign/i;

/** Inspect the filled DOM; the model does not get to waive required or sensitive fields. */
export async function inspectFormReviewNeeds(page: Page): Promise<FormReviewNeeds> {
  try {
    return await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"));
      const missing: string[] = [];
      const sensitive: string[] = [];
      for (const field of controls) {
        if (field.disabled || field.type === "hidden") continue;
        const visible = field.getClientRects().length > 0;
        if (!visible) continue;
        const label = [
          field.getAttribute("aria-label"), field.getAttribute("name"), field.getAttribute("id"), field.getAttribute("placeholder"),
          field.labels?.[0]?.textContent,
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || "Unnamed field";
        const value = field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")
          ? field.checked ? "checked" : ""
          : field.value.trim();
        if ((field.required || field.getAttribute("aria-required") === "true") && !value) missing.push(label);
        if (SENSITIVE.test(label)) sensitive.push(label);
      }
      return { missing: [...new Set(missing)].slice(0, 10), sensitive: [...new Set(sensitive)].slice(0, 10) };
    });
  } catch {
    return { missing: [], sensitive: [] };
  }
}

export function formNeedsMessage(needs: FormReviewNeeds): string | null {
  const parts: string[] = [];
  if (needs.missing.length) parts.push(`Missing required fields: ${needs.missing.join(", ")}`);
  if (needs.sensitive.length) parts.push(`Sensitive fields require your confirmation: ${needs.sensitive.join(", ")}`);
  return parts.length ? parts.join(". ") : null;
}
