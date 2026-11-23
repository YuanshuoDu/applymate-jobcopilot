import { describe, expect, it, vi } from "vitest";
import { formAnswerKeyForSelector } from "../form-answer-key.js";
import { assertSubmissionAuthorized, clickSubmit, confirmedAnswerForField, confirmedAnswerForLabel, fillCustomQuestions, isSensitiveQuestion } from "./helpers.js";

describe("sensitive form questions", () => {
  it("requires explicit handling for salary, visa, legal and signature fields", () => {
    for (const label of ["Salary expectation", "Visa sponsorship", "Criminal history", "Electronic signature"]) {
      expect(isSensitiveQuestion(label)).toBe(true);
    }
    expect(isSensitiveQuestion("Portfolio URL")).toBe(false);
  });

  it("uses a sensitive value only when the candidate confirmed the matching label", () => {
    expect(confirmedAnswerForLabel({ "Visa sponsorship": "No" }, "visa sponsorship required")).toBe("No");
    expect(confirmedAnswerForLabel({ salary: "€80,000" }, "visa sponsorship")).toBe("");
  });

  it("keeps legacy matching while requiring exact selector keys for V2 answers", async () => {
    expect(confirmedAnswerForField({ "Visa sponsorship": "No" }, null, null, "visa sponsorship required")).toBe("No");

    const makePage = () => {
      const field = {
        isVisible: vi.fn(async () => true),
        inputValue: vi.fn(async () => ""),
        getAttribute: vi.fn(async (name: string) => name === "id" ? "salary-field" : name === "name" ? "salary" : null),
        evaluate: vi.fn(async () => ({ tagName: "input", type: "text", multiple: false, options: [] })),
      };
      return { field, page: { $$: vi.fn(async () => [field]), fill: vi.fn(async () => {}), type: vi.fn(async () => {}) } };
    };
    const salaryKey = formAnswerKeyForSelector("salary-field", "salary")!;
    const visaKey = formAnswerKeyForSelector("visa-field", "visa")!;
    const exact = makePage();
    await fillCustomQuestions(exact.page as never, {}, [], { [salaryKey]: "€80,000" });
    expect(exact.page.fill).toHaveBeenCalledWith("#salary-field", "");
    expect(exact.page.type).toHaveBeenCalled();

    const wrong = makePage();
    await fillCustomQuestions(wrong.page as never, {}, [], { [visaKey]: "€80,000" });
    expect(wrong.page.fill).not.toHaveBeenCalled();

    const ambiguous = makePage();
    const duplicate = makePage();
    ambiguous.page.$$ = vi.fn(async () => [ambiguous.field, duplicate.field]);
    await fillCustomQuestions(ambiguous.page as never, {}, [], { [salaryKey]: "€80,000" });
    expect(ambiguous.page.fill).not.toHaveBeenCalled();
  });

  it("fills a select only when one exact value or label matches", async () => {
    const makeSelect = (options: Array<{ index: number; value: string; label: string; disabled: boolean }>) => {
      const field = {
        isVisible: vi.fn(async () => true), inputValue: vi.fn(async () => ""),
        getAttribute: vi.fn(async (name: string) => name === "id" ? "country-field" : name === "name" ? "country" : null),
        evaluate: vi.fn(async () => ({ tagName: "select", type: "", multiple: false, options })),
      };
      const selectOption = vi.fn(async () => []);
      return { field, selectOption, page: { $$: vi.fn(async () => [field]), locator: vi.fn(() => ({ selectOption })) } };
    };
    const key = formAnswerKeyForSelector("country-field", "country")!;
    const exact = makeSelect([{ index: 0, value: "", label: "Choose", disabled: false }, { index: 1, value: "IE", label: "Ireland", disabled: false }]);
    await fillCustomQuestions(exact.page as never, {}, [], { [key]: "Ireland" });
    expect(exact.selectOption).toHaveBeenCalledWith({ index: 1 });

    const ambiguous = makeSelect([{ index: 0, value: "IE", label: "Ireland", disabled: false }, { index: 1, value: "IRL", label: "Ireland", disabled: false }]);
    await fillCustomQuestions(ambiguous.page as never, {}, [], { [key]: "Ireland" });
    expect(ambiguous.selectOption).not.toHaveBeenCalled();
  });
});

describe("submission authorization guard", () => {
  it("blocks when the runtime guard is missing", async () => {
    await expect(assertSubmissionAuthorized()).resolves.toMatchObject({
      authorized: false,
      reason: "missing_guard",
    });
  });

  it("blocks when the runtime guard denies submission", async () => {
    await expect(assertSubmissionAuthorized(() => false)).resolves.toMatchObject({
      authorized: false,
      reason: "guard_false",
    });
  });

  it("forwards the derived request intent into the runtime guard", async () => {
    const intent = { url: "https://apply.example.com/submit", method: "POST" };
    const guard = vi.fn().mockResolvedValue(true);

    await expect(assertSubmissionAuthorized(guard, intent)).resolves.toEqual({ authorized: true });
    expect(guard).toHaveBeenCalledWith(intent);
  });

  it("keeps the generic guard intent-only and gives the exact locator only to its verifier", async () => {
    const click = vi.fn();
    const submitter = {
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
      evaluate: vi.fn(async () => ({ url: "https://apply.example.com/submit", method: "POST" })),
      click,
    };
    const guard = vi.fn().mockResolvedValue(true);
    const verifySubmitter = vi.fn().mockResolvedValue(true);
    const page = {
      url: vi.fn(() => "https://apply.example.com/form"),
      locator: vi.fn(() => ({ first: () => submitter })),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    };

    await expect(clickSubmit(page as never, ["button[type='submit']"], guard, verifySubmitter)).resolves.toEqual({ outcome: "submitted" });
    expect(verifySubmitter).toHaveBeenCalledWith(submitter);
    expect(guard).toHaveBeenCalledWith({ url: "https://apply.example.com/submit", method: "POST" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("does not invoke the guard or click when the submitter verifier denies", async () => {
    const click = vi.fn();
    const submitter = {
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      evaluate: vi.fn().mockResolvedValue({ url: "https://apply.example.com/submit", method: "POST" }),
      click,
    };
    const page = {
      url: vi.fn(() => "https://apply.example.com/form"),
      locator: vi.fn(() => ({ first: () => submitter })),
    };
    const guard = vi.fn().mockResolvedValue(true);
    const verifySubmitter = vi.fn().mockResolvedValue(false);

    await expect(clickSubmit(page as never, ["button[type='submit']"], guard, verifySubmitter))
      .resolves.toMatchObject({ outcome: "blocked", reason: "guard_false" });
    expect(verifySubmitter).toHaveBeenCalledWith(submitter);
    expect(guard).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("does not call the guard when submitter verification resolves after the authorization timeout", async () => {
    vi.useFakeTimers();
    try {
      const click = vi.fn();
      const submitter = {
        count: vi.fn().mockResolvedValue(1),
        isVisible: vi.fn().mockResolvedValue(true),
        evaluate: vi.fn().mockResolvedValue({ url: "https://apply.example.com/submit", method: "POST" }),
        click,
      };
      const page = {
        url: vi.fn(() => "https://apply.example.com/form"),
        locator: vi.fn(() => ({ first: () => submitter })),
      };
      const guard = vi.fn().mockResolvedValue(true);
      let resolveVerification!: (verified: boolean) => void;
      const verification = new Promise<boolean>((resolve) => { resolveVerification = resolve; });
      const verifySubmitter = vi.fn(() => verification);
      const result = clickSubmit(page as never, ["button[type='submit']"], guard, verifySubmitter);

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toMatchObject({ outcome: "blocked", reason: "guard_timeout" });
      resolveVerification(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(guard).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks when the runtime guard throws", async () => {
    await expect(assertSubmissionAuthorized(() => {
      throw new Error("revoked");
    })).resolves.toMatchObject({
      authorized: false,
      reason: "guard_error",
    });
  });

  it("blocks when the runtime guard returns a non-boolean value", async () => {
    await expect(assertSubmissionAuthorized(() => "yes")).resolves.toMatchObject({
      authorized: false,
      reason: "guard_non_boolean",
    });
  });

  it("blocks when the runtime guard times out", async () => {
    vi.useFakeTimers();
    try {
      const result = assertSubmissionAuthorized(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(result).resolves.toMatchObject({
        authorized: false,
        reason: "guard_timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not click a visible submit button when the guard is missing", async () => {
    const click = vi.fn();
    const page = {
      url: vi.fn(() => "https://apply.example.com/form"),
      locator: vi.fn(() => ({
        first: () => ({
          count: vi.fn(async () => 1),
          isVisible: vi.fn(async () => true),
          evaluate: vi.fn(async () => ({ url: "https://apply.example.com/submit", method: "POST" })),
          click,
        }),
      })),
      waitForLoadState: vi.fn(),
    };

    const result = await clickSubmit(page as never, ["button[type='submit']"]);

    expect(result).toMatchObject({ outcome: "blocked", reason: "missing_guard" });
    expect(click).not.toHaveBeenCalled();
  });

  it("fails closed before authorization when no precise submit request intent exists", async () => {
    const click = vi.fn();
    const guard = vi.fn().mockResolvedValue(true);
    const page = {
      url: vi.fn(() => "https://apply.example.com/form"),
      locator: vi.fn(() => ({
        first: () => ({
          count: vi.fn(async () => 1),
          isVisible: vi.fn(async () => true),
          evaluate: vi.fn(async () => null),
          click,
        }),
      })),
      waitForLoadState: vi.fn(),
    };

    await expect(clickSubmit(page as never, ["button[type='submit']"], guard)).resolves.toMatchObject({
      outcome: "blocked",
      reason: "missing_intent",
    });
    expect(guard).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
