export interface ServerSentEvent {
  event?: string
  data: string
}

export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<ServerSentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let eventName: string | undefined
  let dataLines: string[] = []

  const flush = (): ServerSentEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined
      return undefined
    }
    const event = { ...(eventName ? { event: eventName } : {}), data: dataLines.join("\n") }
    eventName = undefined
    dataLines = []
    return event
  }

  const processLine = (line: string): ServerSentEvent | undefined => {
    if (line === "") return flush()
    if (line.startsWith(":") || !line.includes(":")) return undefined
    const separator = line.indexOf(":")
    const field = line.slice(0, separator)
    const value = line.slice(separator + 1).startsWith(" ")
      ? line.slice(separator + 2)
      : line.slice(separator + 1)
    if (field === "event") eventName = value
    if (field === "data") dataLines.push(value)
    return undefined
  }

  const cancelOnAbort = () => { void reader.cancel().catch(() => undefined) }
  if (signal) {
    if (signal.aborted) cancelOnAbort()
    else signal.addEventListener("abort", cancelOnAbort, { once: true })
  }

  try {
    while (true) {
      const result = await reader.read()
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        const event = processLine(line)
        if (event) yield event
        newline = buffer.indexOf("\n")
      }
      if (result.done) break
    }
    if (buffer) {
      const event = processLine(buffer.replace(/\r$/, ""))
      if (event) yield event
    }
    const event = flush()
    if (event) yield event
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
