import type { Locator, Page } from "playwright-core";

export type SubmissionRequestIntent = { url: string; method: string };

type SubmitterTarget = { url: string; method: string } | null;

function normalizeRequestUrl(value: string, base?: string): string | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function normalizeMethod(value: string): string | null {
  const method = value.trim().toUpperCase();
  // GET form submissions append successful controls to the action URL. The
  // action alone therefore cannot identify the exact network request safely.
  return method === "POST" ? method : null;
}

export function isValidSubmissionIntent(value: unknown): value is SubmissionRequestIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    const urlDescriptor = Object.getOwnPropertyDescriptor(value, "url");
    const methodDescriptor = Object.getOwnPropertyDescriptor(value, "method");
    if (
      !urlDescriptor ||
      !("value" in urlDescriptor) ||
      typeof urlDescriptor.value !== "string" ||
      !methodDescriptor ||
      !("value" in methodDescriptor) ||
      typeof methodDescriptor.value !== "string"
    ) {
      return false;
    }
    return Boolean(
      normalizeRequestUrl(urlDescriptor.value) &&
      normalizeMethod(methodDescriptor.value),
    );
  } catch {
    return false;
  }
}

/** Read the native network target implied by this specific HTML form submitter. */
export async function readSubmissionRequestIntent(
  page: Page,
  submitter: Locator,
): Promise<SubmissionRequestIntent | null> {
  try {
    const target = await submitter.evaluate((element): SubmitterTarget => {
      const tagName = element.tagName.toUpperCase();
      let form: HTMLFormElement | null = null;
      let type = "";

      if (tagName === "BUTTON") {
        const button = element as HTMLButtonElement;
        form = button.form;
        type = button.type;
      } else if (tagName === "INPUT") {
        const input = element as HTMLInputElement;
        form = input.form;
        type = input.type;
      } else {
        return null;
      }

      if (!form || (type !== "submit" && type !== "image")) return null;

      const action = element.hasAttribute("formaction")
        ? (element as HTMLButtonElement | HTMLInputElement).formAction
        : form.action;
      const method = element.hasAttribute("formmethod")
        ? (element as HTMLButtonElement | HTMLInputElement).formMethod
        : form.method;
      const submitterTarget = element.hasAttribute("formtarget")
        ? (element as HTMLButtonElement | HTMLInputElement).formTarget
        : form.target;
      const baseTarget = element.ownerDocument.querySelector("base[target]")?.getAttribute("target") ?? "";
      const effectiveTarget = submitterTarget.trim() || baseTarget.trim();
      if (effectiveTarget && effectiveTarget.toLowerCase() !== "_self") return null;
      if (!action || !method) return null;
      return { url: action, method };
    });

    if (!target) return null;
    const url = normalizeRequestUrl(target.url, page.url());
    const method = normalizeMethod(target.method);
    return url && method ? { url, method } : null;
  } catch {
    return null;
  }
}

/** Match only the exact normalized URL and method derived from the submitter. */
export function matchesSubmissionRequest(
  intent: SubmissionRequestIntent | null,
  request: { url(): string; method(): string },
): boolean {
  if (!intent) return false;
  try {
    const intentUrl = normalizeRequestUrl(intent.url);
    const requestUrl = normalizeRequestUrl(request.url());
    const intentMethod = normalizeMethod(intent.method);
    const requestMethod = normalizeMethod(request.method());
    return Boolean(
      intentUrl &&
      requestUrl &&
      intentMethod &&
      requestMethod &&
      intentUrl === requestUrl &&
      intentMethod === requestMethod,
    );
  } catch {
    return false;
  }
}
