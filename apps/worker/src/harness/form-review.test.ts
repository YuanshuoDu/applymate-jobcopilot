import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { formAnswerKeyForSelector } from "../form-answer-key.js";
import { formNeedsMessage, inspectFormReviewNeeds } from "./form-review.js";

class IsolatedInput {
  tagName = "INPUT";
  disabled = false;
  required = false;
  checked = false;
  type = "text";
  multiple = false;
  value = "";
  labels: Array<{ textContent: string }> = [];

  constructor(private readonly attributes: Record<string, string>) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getClientRects(): object[] {
    return [{}];
  }
}

class IsolatedTextArea extends IsolatedInput {
  override tagName = "TEXTAREA";
}

class IsolatedSelect extends IsolatedInput {
  override tagName = "SELECT";
}

function isolatedPage(fields: IsolatedInput[]): Page {
  const evaluate = vi.fn(async (callback: () => unknown) => {
    const serializedResult = runInNewContext(`JSON.stringify((${callback.toString()})())`, {
      document: { querySelectorAll: () => fields },
      HTMLInputElement: IsolatedInput,
      HTMLTextAreaElement: IsolatedTextArea,
      HTMLSelectElement: IsolatedSelect,
    });
    if (typeof serializedResult !== "string") throw new Error("Page callback returned no serialized result");
    return JSON.parse(serializedResult) as unknown;
  });
  return { evaluate } as unknown as Page;
}

describe("form review needs", () => {
  it("keeps required and sensitive fields as separate user-review reasons", () => {
    expect(formNeedsMessage({
      missing: [{ key: "form-answer-v2-" + "a".repeat(64), label: "Portfolio" }],
      sensitive: [{ key: "form-answer-v2-" + "b".repeat(64), label: "Visa sponsorship" }, { key: "form-answer-v2-" + "c".repeat(64), label: "Salary expectation" }],
    })).toBe("Missing required fields: Portfolio. Sensitive fields require your confirmation: Visa sponsorship, Salary expectation");
  });

  it("returns null when the filled form has no programmatic review blockers", () => {
    expect(formNeedsMessage({ missing: [], sensitive: [] })).toBeNull();
  });

  it("returns opaque keys derived from selector identity without exposing selector values", async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({
        missing: [
          { id: "candidate-email", name: "email", label: "Email address", tagName: "input", type: "text", multiple: false },
          { id: "duplicate-field", name: "first", label: "Work authorization", tagName: "input", type: "text", multiple: false },
          { id: "duplicate-field", name: "second", label: "Additional authorization", tagName: "input", type: "text", multiple: false },
          { id: null, name: null, label: "Unstable field", tagName: "input", type: "text", multiple: false },
          { id: "country-select", name: "country", label: "Country", tagName: "select", type: "", multiple: false },
          { id: "countries-select", name: "countries", label: "Countries", tagName: "select", type: "", multiple: true },
        ],
        sensitive: [{ id: "salary-field", name: "salary", label: "Salary expectation", tagName: "input", type: "text", multiple: false }],
        selectors: [
          { id: "candidate-email", name: "email" },
          { id: "duplicate-field", name: "first" }, { id: "duplicate-field", name: "second" },
          { id: null, name: null }, { id: "salary-field", name: "salary" },
          { id: "country-select", name: "country" }, { id: "countries-select", name: "countries" },
        ],
      }),
    } as unknown as Page;

    const needs = await inspectFormReviewNeeds(page);

    expect(needs).toEqual({
      missing: [
        { key: formAnswerKeyForSelector("candidate-email", "email"), label: "Email address" },
        { key: null, label: "Work authorization" }, { key: null, label: "Additional authorization" },
        { key: null, label: "Unstable field" },
        { key: formAnswerKeyForSelector("country-select", "country"), label: "Country" }, { key: null, label: "Countries" },
      ],
      sensitive: [{ key: formAnswerKeyForSelector("salary-field", "salary"), label: "Salary expectation" }],
    });
    expect(JSON.stringify(needs)).not.toContain("candidate-email");
    expect(JSON.stringify(needs)).not.toContain("salary-field");
  });

  it("classifies required and sensitive controls inside an isolated serialized page context", async () => {
    const firstName = new IsolatedInput({ id: "first-name", name: "firstName", "aria-label": "First name" });
    firstName.required = true;
    const workAuthorization = new IsolatedInput({ id: "work-auth", name: "workAuthorization", "aria-label": "Work authorization" });
    workAuthorization.required = true;
    const answeredSalary = new IsolatedInput({ id: "salary", name: "salary", "aria-label": "Salary expectation" });
    answeredSalary.value = "75000";

    const needs = await inspectFormReviewNeeds(isolatedPage([firstName, workAuthorization, answeredSalary]));

    expect(needs).toEqual({
      missing: [
        { key: formAnswerKeyForSelector("first-name", "firstName"), label: "First name" },
        { key: formAnswerKeyForSelector("work-auth", "workAuthorization"), label: "Work authorization" },
      ],
      sensitive: [{ key: formAnswerKeyForSelector("work-auth", "workAuthorization"), label: "Work authorization" }],
    });
  });

  it("propagates unreadable form inspection instead of treating it as clean", async () => {
    const page = { evaluate: vi.fn().mockRejectedValue(new Error("DOM inspection failed")) } as unknown as Page;

    await expect(inspectFormReviewNeeds(page)).rejects.toThrow("DOM inspection failed");
  });

  it("keeps one control answerable when it is both missing and sensitive", async () => {
    const field = { id: "visa-field", name: "visa", label: "Visa sponsorship", tagName: "input", type: "text", multiple: false };
    const page = { evaluate: vi.fn().mockResolvedValue({ missing: [field], sensitive: [field], selectors: [{ id: field.id, name: field.name }] }) } as unknown as Page;

    const needs = await inspectFormReviewNeeds(page);

    const key = formAnswerKeyForSelector(field.id, field.name);
    expect(needs).toEqual({ missing: [{ key, label: field.label }], sensitive: [{ key, label: field.label }] });
  });
});
