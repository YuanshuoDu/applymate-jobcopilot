import { describe, expect, it } from "vitest"

import { readServerSentEvents } from "./sse.js"

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe("readServerSentEvents", () => {
  it("reassembles CRLF events across arbitrary chunk boundaries", async () => {
    const input = ["event: response.out", "put_text.delta\r\nda", "ta: hello\r\n\r\ndata: world\r\n\r\n"]
    const events = []
    for await (const event of readServerSentEvents(stream(input))) events.push(event)
    expect(events).toEqual([{ event: "response.output_text.delta", data: "hello" }, { data: "world" }])
  })

  it("flushes a final event without a trailing newline and ignores comments", async () => {
    const events = []
    for await (const event of readServerSentEvents(stream([": keepalive\ndata: [DONE]"]))) events.push(event)
    expect(events).toEqual([{ data: "[DONE]" }])
  })
})
