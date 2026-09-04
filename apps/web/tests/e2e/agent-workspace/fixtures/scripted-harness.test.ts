import { describe, expect, it } from "vitest";
import { copy, documentFor } from "./scripted-harness";

const requiredKeys = [
  "workspace", "composer", "send", "stop", "approve", "reject", "requestApproval", "reconnect",
  "complete", "unknownEvent", "unknownTypes", "timeout", "final", "noExternalWrites",
];

describe("scripted Harness locale contract", () => {
  it("keeps the English and Chinese fixture dictionaries structurally aligned", () => {
    for (const key of requiredKeys) {
      expect(copy.en[key], `missing English copy for ${key}`).toBeTruthy();
      expect(copy.zh[key], `missing Chinese copy for ${key}`).toBeTruthy();
    }
  });

  it("renders a locale-specific accessible document without cross-locale shell text", () => {
    const english = documentFor("en");
    const chinese = documentFor("zh");

    expect(english).toContain(copy.en.workspace);
    expect(english).toContain(copy.en.composer);
    expect(chinese).toContain(copy.zh.workspace);
    expect(chinese).toContain(copy.zh.composer);
    expect(chinese).not.toContain(copy.en.workspace);
    expect(chinese).not.toContain(copy.en.send);
  });
});
