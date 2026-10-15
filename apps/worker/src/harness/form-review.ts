import type { Page } from "playwright-core";
import { formAnswerKeyForSelector, isAnswerableFormControl } from "../form-answer-key.js";

export type FormReviewField = { key: string | null; label: string };
export interface FormReviewNeeds {
  missing: FormReviewField[];
  sensitive: FormReviewField[];
}

const SENSITIVE = /salary|compensation|pay|visa|sponsor|work.?authori[sz]|citizen|nationality|legal|criminal|disability|gender|race|ethnic|signature|e-?sign/i;
type RawField = { id: string | null; name: string | null; label: string; tagName: string; type: string; multiple: boolean };

/** Inspect the filled DOM; the model does not get to waive required or sensitive fields. */
export async function inspectFormReviewNeeds(page: Page): Promise<FormReviewNeeds> {
  try {
    const raw = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"));
      const missing: RawField[] = [];
      const sensitive: RawField[] = [];
      const selectors: Array<{ id: string | null; name: string | null }> = [];
      for (const field of controls) {
        if (field.disabled || field.type === "hidden") continue;
        const visible = field.getClientRects().length > 0;
        if (!visible) continue;
        const id = field.getAttribute("id");
        const name = field.getAttribute("name");
        selectors.push({ id, name });
        const label = [field.getAttribute("aria-label"), field.labels?.[0]?.textContent, field.getAttribute("placeholder")]
          .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        const value = field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio")
          ? field.checked ? "checked" : ""
          : field.value.trim();
        const rawField = { id, name, label, tagName: field.tagName.toLowerCase(), type: field instanceof HTMLInputElement ? field.type : "", multiple: field instanceof HTMLSelectElement && field.multiple };
        if ((field.required || field.getAttribute("aria-required") === "true") && !value) missing.push(rawField);
        if (SENSITIVE.test(label + " " + (name ?? "") + " " + (id ?? "")) && !value) sensitive.push(rawField);
      }
      return { missing: missing.slice(0, 10), sensitive: sensitive.slice(0, 10), selectors };
    });
    const identities = new Map<string, number>();
    for (const { id, name } of raw.selectors) {
      const key = formAnswerKeyForSelector(id, name);
      if (key) identities.set(key, (identities.get(key) ?? 0) + 1);
    }
    return { missing: safeFields(raw.missing, "Required application field", identities), sensitive: safeFields(raw.sensitive, "Sensitive answer requiring confirmation", identities) };
  } catch (error) {
    throw error;
  }
}

function safeFields(fields: RawField[], fallback: string, identities: Map<string, number>): FormReviewField[] {
  const seen = new Set<string>();
  return fields.flatMap(({ id, name, label, tagName, type, multiple }) => {
    const identity = isAnswerableFormControl(tagName, type, multiple) ? formAnswerKeyForSelector(id, name) : null;
    const key = identity && identities.get(identity) === 1 ? identity : null;
    const safeLabel = label.slice(0, 200) || fallback;
    const dedupeKey = key ?? fallback + ":" + safeLabel;
    if (seen.has(dedupeKey)) return [];
    seen.add(dedupeKey);
    return [{ key, label: safeLabel }];
  }).slice(0, 10);
}

export function formNeedsMessage(needs: FormReviewNeeds): string | null {
  const parts: string[] = [];
  if (needs.missing.length) parts.push("Missing required fields: " + needs.missing.map(field => field.label).join(", "));
  if (needs.sensitive.length) parts.push("Sensitive fields require your confirmation: " + needs.sensitive.map(field => field.label).join(", "));
  return parts.length ? parts.join(". ") : null;
}
