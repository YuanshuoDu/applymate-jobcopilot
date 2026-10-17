import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { formAnswerKeyForSelector } from "../form-answer-key.js";
import { formNeedsMessage, inspectFormReviewNeeds } from "./form-review.js";

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
