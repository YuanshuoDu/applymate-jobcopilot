import type { Page } from "playwright-core";

/** A single perceived form field extracted from the DOM */
export interface PerceivedField {
  selector: string;
  type: "text" | "email" | "tel" | "select" | "checkbox" | "radio" | "file" | "textarea" | "number" | "url" | "date";
  label: string;
  required: boolean;
  currentValue: string;
  options?: string[];
}

/**
 * Extract all visible, interactable form fields from the current page.
 * Runs inside the browser context via `page.evaluate()`.
 */
export async function perceiveFields(page: Page): Promise<PerceivedField[]> {
  return page.evaluate(() => {
    const fields: PerceivedField[] = [];
    const seen = new Set<string>();

    const allInteractive = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), ' +
      'textarea, select, [contenteditable="true"]'
    );

    for (const el of Array.from(allInteractive)) {
      const htmlEl = el as HTMLElement;
      // Skip invisible/hidden elements
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const tag = htmlEl.tagName.toLowerCase();
      let type = "";
      let selector = "";
      let label = "";
      let required = false;
      let currentValue = "";
      let options: string[] | undefined;

      if (tag === "input") {
        const input = htmlEl as HTMLInputElement;
        type = input.type || "text";
        selector = buildSelector(htmlEl);
        label = findLabel(htmlEl);
        required = input.required || htmlEl.getAttribute("aria-required") === "true";
        currentValue = input.value;
      } else if (tag === "textarea") {
        type = "textarea";
        selector = buildSelector(htmlEl);
        label = findLabel(htmlEl);
        required = htmlEl.getAttribute("aria-required") === "true";
        currentValue = (htmlEl as HTMLTextAreaElement).value;
      } else if (tag === "select") {
        type = "select";
        selector = buildSelector(htmlEl);
        label = findLabel(htmlEl);
        required = htmlEl.getAttribute("aria-required") === "true";
        const select = htmlEl as HTMLSelectElement;
        currentValue = select.value;
        options = Array.from(select.options).map((o) => o.textContent?.trim() ?? o.value);
      } else if (htmlEl.getAttribute("contenteditable") === "true") {
        type = "textarea";
        selector = `[contenteditable="true"]`;
        label = findLabel(htmlEl);
        required = false;
        currentValue = htmlEl.textContent?.trim() ?? "";
      } else {
        continue;
      }

      // Deduplicate
      const dedupeKey = `${selector}:${label}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      fields.push({
        selector,
        type: type as PerceivedField["type"],
        label,
        required,
        currentValue,
        ...(options ? { options } : {}),
      });
    }

    return fields;

    // ── helpers (run in browser context) ──

    function buildSelector(el: HTMLElement): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const name = el.getAttribute("name");
      if (name) return `[name="${CSS.escape(name)}"]`;
      const dataTestId = el.getAttribute("data-testid");
      if (dataTestId) return `[data-testid="${CSS.escape(dataTestId)}"]`;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;
      // Fallback: nth-of-type in parent
      const parent = el.parentElement;
      if (parent) {
        const tag = el.tagName.toLowerCase();
        const siblings = Array.from(parent.querySelectorAll(`:scope > ${tag}, :scope > input, :scope > textarea, :scope > select`));
        const idx = siblings.indexOf(el) + 1;
        if (idx > 0) return `${tag}:nth-of-type(${idx})`;
      }
      return el.tagName.toLowerCase();
    }

    function findLabel(el: HTMLElement): string {
      // 1. <label for="id">
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (labelEl) return (labelEl.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      // 2. Parent <label>
      let parent = el.parentElement;
      while (parent) {
        if (parent.tagName === "LABEL") return (parent.textContent ?? "").replace(/\s+/g, " ").trim();
        parent = parent.parentElement;
      }
      // 3. Placeholder
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder;
      // 4. aria-label
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel;
      // 5. Preceding text sibling
      const prevSibling = el.previousElementSibling;
      if (prevSibling) {
        const text = (prevSibling.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text.length > 0 && text.length < 200) return text;
      }
      return el.getAttribute("name") ?? "";
    }
  });
}
