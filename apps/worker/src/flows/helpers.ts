import type { Page } from "playwright-core";
import { formAnswerKeyForSelector, isAnswerableFormControl, isFormAnswerKeyV2 } from "../form-answer-key.js";
import { readSubmissionRequestIntent, type SubmissionRequestIntent } from "./submission-intent.js";

export type FlowLogEntry = { field?: string; selector?: string; action: string };

export function getPersonaValue(persona: Record<string, string>, key: string): string {
  if (persona[key]) return persona[key];
  if (key === "firstName" && persona.fullName) return persona.fullName.trim().split(/\s+/)[0] ?? "";
  if (key === "lastName" && persona.fullName) { const parts = persona.fullName.trim().split(/\s+/); return parts.length > 1 ? parts.slice(1).join(" ") : ""; }
  return "";
}

export function normalizeLabel(value: string): string { return value.replace(/[-_[\]]/g, " ").toLowerCase().trim(); }

export function isSensitiveQuestion(value: string): boolean { return /salary|compensation|pay|visa|sponsor|work.?authori[sz]|citizen|nationality|legal|criminal|disability|gender|race|ethnic|signature|e-?sign/i.test(value) }

export function confirmedAnswerForLabel(
  answers: Record<string, string> | undefined,
  label: string,
): string {
  if (!answers) return "";
  const normalizedLabel = normalizeLabel(label);
  const match = Object.entries(answers).find(([key, value]) => {
    const normalizedKey = normalizeLabel(key);
    return Boolean(value && normalizedKey && (normalizedKey === normalizedLabel || normalizedKey.includes(normalizedLabel) || normalizedLabel.includes(normalizedKey)));
  });
  return match?.[1] ?? "";
}
export function confirmedAnswerForField(answers: Record<string, string> | undefined, id: string | null, name: string | null, label: string, ambiguous = false): string {
  if (!answers || !Object.keys(answers).some(isFormAnswerKeyV2)) return answers ? confirmedAnswerForLabel(answers, label) : "";
  const key = ambiguous ? null : formAnswerKeyForSelector(id, name); return key ? answers[key] ?? "" : "";
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
  log: FlowLogEntry[],
  confirmedAnswers?: Record<string, string>,
): Promise<void> {
  try {
    const selectorFields = await Promise.all((await page.$$("textarea:not([disabled]), input:not([disabled]), select:not([disabled])")).map(async handle => {
      const details = await handle.evaluate(field => {
        const select = field instanceof HTMLSelectElement;
        return {
          tagName: field.tagName.toLowerCase(), type: field instanceof HTMLInputElement ? field.type : "",
          multiple: select && field.multiple,
          options: select ? Array.from(field.options, (option, index) => ({ index, value: option.value, label: option.label, disabled: option.disabled })) : [],
        };
      });
      return { handle, idAttr: (await handle.getAttribute("id")) ?? "", nameAttr: (await handle.getAttribute("name")) ?? "", visible: await handle.isVisible().catch(() => false), ...details };
    }));
    const identityCounts = new Map<string, number>(); selectorFields.forEach(({ visible, idAttr, nameAttr }) => { const key = formAnswerKeyForSelector(idAttr || null, nameAttr || null); if (visible && key) identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1); });
    const hasV2Answers = Object.keys(confirmedAnswers ?? {}).some(isFormAnswerKeyV2);
    for (const { handle, idAttr, nameAttr, visible, tagName, type, multiple, options } of selectorFields) {
      try {
        if (!visible || !isAnswerableFormControl(tagName, type, multiple) || await handle.inputValue().catch(() => "")) continue;
        const label = normalizeLabel(`${nameAttr} ${idAttr}`);
        if (!label) continue;
        const identity = formAnswerKeyForSelector(idAttr || null, nameAttr || null);
        const confirmed = confirmedAnswerForField(confirmedAnswers, idAttr || null, nameAttr || null, label, Boolean(identity && identityCounts.get(identity) !== 1));
        if (isSensitiveQuestion(label) && !confirmed) continue;
        const selector = idAttr ? `#${escapeSelectorValue(idAttr)}` : nameAttr ? `[name="${escapeSelectorValue(nameAttr)}"]` : null;
        if (!selector) continue;
        if (tagName === "select") {
          if (!hasV2Answers || !confirmed) continue;
          const matching = options.filter(option => !option.disabled && (option.value === confirmed || option.label.trim() === confirmed.trim()));
          if (matching.length !== 1) continue;
          await page.locator(selector).selectOption({ index: matching[0]!.index });
          log.push({ field: "candidate_confirmed", selector, action: "fill-custom" });
          continue;
        }
        const matchKey = confirmed ? "candidate_confirmed" : Object.keys(persona).find(key => {
          const normalizedKey = normalizeLabel(key);
          return Boolean(normalizedKey && persona[key] && (label.includes(normalizedKey) || normalizedKey.includes(label)));
        });
        if (!matchKey) continue;
        await humanType(page, selector, confirmed || String(persona[matchKey]));
        log.push({ field: matchKey, selector, action: "fill-custom" });
      } catch {
        continue;
      }
    }
  } catch {
    // Best-effort custom field scan.
  }
}

export type SubmissionBlockedReason =
  | "missing_guard"
  | "missing_intent"
  | "guard_false"
  | "guard_error"
  | "guard_timeout"
  | "guard_non_boolean";
export type SubmissionAuthorization =
  | { authorized: true }
  | { authorized: false; reason: SubmissionBlockedReason; message: string };

export type SubmissionGuard = (intent?: SubmissionRequestIntent) => Promise<unknown> | unknown;

export type SubmitAttempt =
  | { outcome: "submitted" }
  | { outcome: "missing" }
  | { outcome: "blocked"; reason: SubmissionBlockedReason; message: string };

const SUBMISSION_AUTH_TIMEOUT_MS = 5_000;
const SUBMISSION_AUTH_TIMEOUT = Symbol("submission-authorization-timeout");

function blocked(
  reason: SubmissionBlockedReason,
): Extract<SubmissionAuthorization, { authorized: false }> {
  const messages: Record<SubmissionBlockedReason, string> = {
    missing_guard: "Submission blocked: no runtime authorization guard was provided.",
    missing_intent: "Submission blocked: the submit button has no reliable form request target.",
    guard_false: "Submission blocked: runtime authorization guard denied the submit.",
    guard_error: "Submission blocked: runtime authorization guard failed.",
    guard_timeout: "Submission blocked: runtime authorization guard timed out.",
    guard_non_boolean: "Submission blocked: runtime authorization guard returned a non-boolean value.",
  };
  return { authorized: false, reason, message: messages[reason] };
}

export async function assertSubmissionAuthorized(
  beforeSubmit?: SubmissionGuard,
  intent?: SubmissionRequestIntent,
): Promise<SubmissionAuthorization> {
  if (!beforeSubmit) return blocked("missing_guard");

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof SUBMISSION_AUTH_TIMEOUT>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(SUBMISSION_AUTH_TIMEOUT), SUBMISSION_AUTH_TIMEOUT_MS);
    });
    const result = await Promise.race([
      Promise.resolve().then(() => beforeSubmit(intent)),
      timeout,
    ]);
    if (result === SUBMISSION_AUTH_TIMEOUT) return blocked("guard_timeout");
    if (typeof result !== "boolean") return blocked("guard_non_boolean");
    return result ? { authorized: true } : blocked("guard_false");
  } catch {
    return blocked("guard_error");
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function clickSubmit(
  page: Page,
  selectors: string[],
  beforeSubmit?: SubmissionGuard,
): Promise<SubmitAttempt> {
  let visibleWithoutIntent = false;
  for (const selector of selectors) {
    try {
      const button = page.locator(selector).first();
      if (!(await button.count())) continue;
      if (!(await button.isVisible().catch(() => false))) continue;
      const intent = await readSubmissionRequestIntent(page, button);
      if (!intent) {
        visibleWithoutIntent = true;
        continue;
      }
      const authorization = await assertSubmissionAuthorized(beforeSubmit, intent);
      if (authorization.authorized === false) {
        console.warn("[submission-guard] blocked", authorization.reason);
        return {
          outcome: "blocked",
          reason: authorization.reason,
          message: authorization.message,
        };
      }
      await button.click();
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      return { outcome: "submitted" };
    } catch {
      continue;
    }
  }
  if (visibleWithoutIntent) {
    const authorization = blocked("missing_intent");
    return {
      outcome: "blocked",
      reason: authorization.reason,
      message: authorization.message,
    };
  }
  return { outcome: "missing" };
}
