import { describe, expect, it } from "vitest";
import type { Locator, Page } from "playwright-core";
import { isValidSubmissionIntent, matchesSubmissionRequest, readSubmissionRequestIntent } from "./submission-intent.js";

function makeSubmitter(input: {
  tagName?: string;
  type?: string;
  form?: { action: string; method: string; target?: string } | null;
  formaction?: string;
  formmethod?: string;
  formtarget?: string;
  baseTarget?: string;
}): Locator {
  const attributes = new Set<string>();
  if (input.formaction !== undefined) attributes.add("formaction");
  if (input.formmethod !== undefined) attributes.add("formmethod");
  if (input.formtarget !== undefined) attributes.add("formtarget");
  const element = {
    tagName: input.tagName ?? "BUTTON",
    type: input.type ?? "submit",
    form: input.form === undefined
      ? { action: "https://apply.example.com/submit", method: "post", target: "" }
      : input.form && { ...input.form, target: input.form.target ?? "" },
    formAction: input.formaction ?? "",
    formMethod: input.formmethod ?? "",
    formTarget: input.formtarget ?? "",
    hasAttribute: (name: string) => attributes.has(name),
    ownerDocument: {
      querySelector: () => input.baseTarget === undefined
        ? null
        : { getAttribute: () => input.baseTarget },
    },
  };
  return {
    evaluate: (callback: (node: Element) => unknown) =>
      Promise.resolve(callback(element as unknown as Element)),
  } as unknown as Locator;
}

const page = { url: () => "https://apply.example.com/form#contact" } as Page;

describe("submission request intent", () => {
  it("validates only plain objects with absolute HTTP(S) POST intents", () => {
    expect(isValidSubmissionIntent({ url: "https://apply.example.com/submit#step", method: "post" })).toBe(true);
    expect(isValidSubmissionIntent({ url: "/submit", method: "POST" })).toBe(false);
    expect(isValidSubmissionIntent({ url: "javascript:alert(1)", method: "POST" })).toBe(false);
    expect(isValidSubmissionIntent({ url: "https://apply.example.com/submit", method: "GET" })).toBe(false);
    expect(isValidSubmissionIntent({ url: "https://apply.example.com/submit", method: "DELETE" })).toBe(false);
    expect(isValidSubmissionIntent([{ url: "https://apply.example.com/submit", method: "POST" }])).toBe(false);
    expect(isValidSubmissionIntent(new (class Intent {
      url = "https://apply.example.com/submit";
      method = "POST";
    })())).toBe(false);
  });

  it("derives method and action overrides from the selected submitter", async () => {
    const intent = await readSubmissionRequestIntent(page, makeSubmitter({
      form: { action: "https://apply.example.com/default", method: "get" },
      formaction: "/api/apply?source=button#confirm",
      formmethod: "post",
    }));

    expect(intent).toEqual({
      url: "https://apply.example.com/api/apply?source=button",
      method: "POST",
    });
  });

  it("uses the associated form target and normalizes the absolute URL", async () => {
    const intent = await readSubmissionRequestIntent(page, makeSubmitter({
      form: { action: "https://APPLY.example.com:443/submit#step-2", method: "post" },
    }));

    expect(intent).toEqual({ url: "https://apply.example.com/submit", method: "POST" });
  });

  it("rejects GET forms because successful controls change the action URL", async () => {
    await expect(readSubmissionRequestIntent(page, makeSubmitter({
      form: { action: "https://apply.example.com/submit", method: "get" },
    }))).resolves.toBeNull();
  });

  it("returns null for a non-submit control or a submitter without an associated form", async () => {
    await expect(readSubmissionRequestIntent(page, makeSubmitter({ type: "button" }))).resolves.toBeNull();
    await expect(readSubmissionRequestIntent(page, makeSubmitter({ form: null }))).resolves.toBeNull();
  });

  it("rejects submitters routed to a popup or another browsing context", async () => {
    await expect(readSubmissionRequestIntent(page, makeSubmitter({ formtarget: "_blank" }))).resolves.toBeNull();
    await expect(readSubmissionRequestIntent(page, makeSubmitter({
      form: { action: "https://apply.example.com/submit", method: "post", target: "results" },
    }))).resolves.toBeNull();
    await expect(readSubmissionRequestIntent(page, makeSubmitter({ baseTarget: "_blank" }))).resolves.toBeNull();
  });

  it("allows an explicit same-page target to override a base target", async () => {
    await expect(readSubmissionRequestIntent(page, makeSubmitter({
      formtarget: "_self",
      baseTarget: "_blank",
    }))).resolves.toEqual({ url: "https://apply.example.com/submit", method: "POST" });
  });

  it("matches only the normalized URL and method", () => {
    const intent = { url: "https://APPLY.example.com:443/submit#button", method: "post" };

    expect(matchesSubmissionRequest(intent, {
      url: () => "https://apply.example.com/submit#request",
      method: () => "POST",
    })).toBe(true);
    expect(matchesSubmissionRequest(intent, {
      url: () => "https://apply.example.com/other",
      method: () => "POST",
    })).toBe(false);
    expect(matchesSubmissionRequest(intent, {
      url: () => "https://apply.example.com/submit",
      method: () => "GET",
    })).toBe(false);
    expect(matchesSubmissionRequest(null, {
      url: () => "https://apply.example.com/submit",
      method: () => "POST",
    })).toBe(false);
  });
});
