import { describe, expect, it } from "vitest"

import { normalizeMiniMaxReasoningResponse } from "./response.js"

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const payload = lines.join("\n")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = encoder.encode(payload)
      controller.enqueue(bytes.slice(0, 7))
      controller.enqueue(bytes.slice(7))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "x-test": "ok" } })
}

function dataLines(payload: string): Record<string, unknown>[] {
  return payload.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

describe("MiniMax reasoning response normalization", () => {
  it("converts cumulative reasoning_details to provider-neutral deltas across chunks", async () => {
    const response = normalizeMiniMaxReasoningResponse(streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ text: "Plan" }] } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ text: "Plan then" }] } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Done" } }] })}`,
    ]))
    const chunks = dataLines(await response.text())
    expect(chunks[0].choices).toEqual([{ delta: { reasoning: "Plan" } }])
    expect(chunks[1].choices).toEqual([{ delta: { reasoning: " then" } }])
    expect(chunks[2].choices).toEqual([{ delta: { content: "Done" } }])
  })

  it("preserves response metadata and non-JSON SSE lines", async () => {
    const response = normalizeMiniMaxReasoningResponse(streamResponse([
      ": keep-alive",
      "",
      "data: [DONE]",
      "",
    ]))
    expect(response.status).toBe(200)
    expect(response.headers.get("x-test")).toBe("ok")
    expect(await response.text()).toContain("data: [DONE]")
  })
})
