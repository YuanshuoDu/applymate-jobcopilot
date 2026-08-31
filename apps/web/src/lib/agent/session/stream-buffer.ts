export type StreamFrameKind = "durable" | "transient"

export interface StreamFrame {
  kind: StreamFrameKind
  body: string
}

export interface BufferPushResult {
  accepted: boolean
  droppedTransient: boolean
  requiresSnapshot: boolean
}

type Waiter = {
  resolve: (frame: StreamFrame | null) => void
  signal: AbortSignal
  onAbort: () => void
}

const DEFAULT_CAPACITY = 128

export class BoundedStreamBuffer {
  private readonly frames: StreamFrame[] = []
  private readonly waiters: Waiter[] = []
  private readonly capacity: number
  private readonly overflowFrame: (droppedCount: number) => StreamFrame
  private overflowPending = false
  private droppedCount = 0
  private closed = false

  constructor(
    overflowFrame: (droppedCount: number) => StreamFrame,
    capacity = DEFAULT_CAPACITY,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 2) throw new Error("Stream buffer capacity must be at least 2")
    this.capacity = capacity
    this.overflowFrame = overflowFrame
  }

  get size(): number {
    return this.frames.length
  }

  push(frame: StreamFrame): BufferPushResult {
    if (this.closed) return { accepted: false, droppedTransient: false, requiresSnapshot: true }
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.signal.removeEventListener("abort", waiter.onAbort)
      waiter.resolve(frame)
      return { accepted: true, droppedTransient: false, requiresSnapshot: false }
    }

    if (this.frames.length >= this.capacity) {
      const transientIndex = this.frames.findIndex((entry) => entry.kind === "transient")
      if (transientIndex < 0) {
        return { accepted: false, droppedTransient: false, requiresSnapshot: frame.kind === "durable" }
      }
      this.frames.splice(transientIndex, 1)
      this.overflowPending = true
      this.droppedCount += 1
      if (frame.kind === "durable") {
        this.frames.push(frame)
        return { accepted: true, droppedTransient: false, requiresSnapshot: false }
      }
      return { accepted: false, droppedTransient: true, requiresSnapshot: false }
    }

    this.enqueueOverflowIfPossible()
    if (this.frames.length >= this.capacity) {
      if (frame.kind === "transient") {
        this.overflowPending = true
        this.droppedCount += 1
        return { accepted: false, droppedTransient: true, requiresSnapshot: false }
      }
      return { accepted: false, droppedTransient: false, requiresSnapshot: true }
    }
    this.frames.push(frame)
    return { accepted: true, droppedTransient: false, requiresSnapshot: false }
  }

  async next(signal: AbortSignal): Promise<StreamFrame | null> {
    if (signal.aborted || this.closed) return null
    this.enqueueOverflowIfPossible()
    const frame = this.frames.shift()
    if (frame) return frame
    return new Promise((resolve) => {
      const onAbort = () => {
        const index = this.waiters.findIndex((entry) => entry.onAbort === onAbort)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(null)
      }
      this.waiters.push({ resolve, signal, onAbort })
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (!waiter) continue
      waiter.signal.removeEventListener("abort", waiter.onAbort)
      waiter.resolve(null)
    }
  }

  private enqueueOverflowIfPossible(): void {
    if (!this.overflowPending || this.frames.length >= this.capacity) return
    this.frames.unshift(this.overflowFrame(this.droppedCount))
    this.overflowPending = false
    this.droppedCount = 0
  }
}
