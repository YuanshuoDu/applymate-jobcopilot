import { describe, expect, it } from "vitest";
import { runExecute } from "./execute";

describe("runExecute", () => {
  it("does not dispatch a browser task from pipeline state alone", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const result = await runExecute([{
      job: { id: "job_1", company: "Acme", role: "Engineer" }, score: 92,
      matchedKeywords: ["TypeScript"], missingKeywords: [], recommendation: "",
    }] as never, { emit: (event: string, data: unknown) => events.push({ event, data }) } as never);
    expect(result.data).toEqual({ queued: [], failed: [] });
    expect(events.some(event => event.event === "application_queued")).toBe(false);
  });
});
