import { Redis } from "ioredis"
import { agentEventChannel } from "@jobcopilot/agent-protocol"

export interface AgentEventPubSubRedis {
  subscribe(channel: string): Promise<unknown>
  unsubscribe(channel: string): Promise<unknown>
  onMessage(listener: (channel: string, message: string) => void): void
  onError(listener: (error: unknown) => void): void
  removeMessageListener(listener: (channel: string, message: string) => void): void
  removeErrorListener(listener: (error: unknown) => void): void
  disconnect(): void
}

export type AgentEventPubSubFactory = () => AgentEventPubSubRedis | null

export interface DurablePollWakeup {
  notify(): void
  wait(milliseconds: number, signal: AbortSignal): Promise<void>
}

export function createDurablePollWakeup(): DurablePollWakeup {
  let queued = false
  let waiter: (() => void) | null = null
  return {
    notify() {
      const current = waiter
      if (current) {
        waiter = null
        current()
      } else queued = true
    },
    wait(milliseconds, signal) {
      if (queued) {
        queued = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        let finished = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = () => {
          if (finished) return
          finished = true
          if (timer !== undefined) clearTimeout(timer)
          signal.removeEventListener("abort", finish)
          if (waiter === finish) waiter = null
          resolve()
        }
        waiter = finish
        if (signal.aborted) finish()
        else {
          signal.addEventListener("abort", finish, { once: true })
          timer = setTimeout(finish, Math.max(0, milliseconds))
        }
      })
    },
  }
}

export async function startAgentEventWakeup(
  sessionId: string,
  factory: AgentEventPubSubFactory | undefined,
  wakeup: DurablePollWakeup,
  signal: AbortSignal,
): Promise<void> {
  const redis = (factory ?? defaultAgentEventPubSubFactory)()
  if (!redis) return
  const channel = agentEventChannel(sessionId)
  const onMessage = (receivedChannel: string) => {
    if (receivedChannel === channel) wakeup.notify()
  }
  let stop: (() => void) | undefined
  const onError = () => stop?.()
  let abortListener: (() => void) | undefined
  const stopped = new Promise<void>((resolve) => {
    stop = resolve
    if (signal.aborted) resolve()
    else {
      abortListener = resolve
      signal.addEventListener("abort", abortListener, { once: true })
    }
  })
  try {
    redis.onMessage(onMessage)
    redis.onError(onError)
    if (!signal.aborted) {
      // Race subscription setup with abort so a stalled Redis connection cannot
      // keep the SSE producer alive after its request has ended.
      const subscribing = redis.subscribe(channel).then(() => true, () => false)
      const result = await Promise.race([subscribing, stopped.then(() => null)])
      if (result === true) await stopped
    }
  } catch {
    // Redis only accelerates the PostgreSQL poll; failures fall back to its timer.
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener)
    try { redis.removeMessageListener(onMessage) } catch { /* Cleanup is best effort. */ }
    try { redis.removeErrorListener(onError) } catch { /* Cleanup is best effort. */ }
    await redis.unsubscribe(channel).catch(() => undefined)
    try { redis.disconnect() } catch { /* Cleanup is best effort. */ }
  }
}

export async function waitForDuration(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, Math.max(0, milliseconds))
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function defaultAgentEventPubSubFactory(): AgentEventPubSubRedis | null {
  const url = process.env.REDIS_URL?.trim()
  if (!url) return null
  const connection = new Redis(url, { lazyConnect: true, connectTimeout: 1_000, maxRetriesPerRequest: 1, retryStrategy: () => null })
  return {
    subscribe: (channel) => connection.subscribe(channel),
    unsubscribe: (channel) => connection.unsubscribe(channel),
    onMessage: (listener) => { connection.on("message", listener) },
    onError: (listener) => { connection.on("error", listener) },
    removeMessageListener: (listener) => { connection.removeListener("message", listener) },
    removeErrorListener: (listener) => { connection.removeListener("error", listener) },
    disconnect: () => connection.disconnect(),
  }
}
