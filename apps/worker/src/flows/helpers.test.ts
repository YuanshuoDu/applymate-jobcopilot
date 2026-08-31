import { describe, expect, it, vi } from "vitest";
import { assertSubmissionAuthorized, clickSubmit, confirmedAnswerForLabel, isSensitiveQuestion } from "./helpers.js";

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
      locator: vi.fn(() => ({
        first: () => ({
          count: vi.fn(async () => 1),
          isVisible: vi.fn(async () => true),
          click,
        }),
      })),
      waitForLoadState: vi.fn(),
    };

    const result = await clickSubmit(page as never, ["button[type='submit']"]);

    expect(result).toMatchObject({ outcome: "blocked", reason: "missing_guard" });
    expect(click).not.toHaveBeenCalled();
  });
});
