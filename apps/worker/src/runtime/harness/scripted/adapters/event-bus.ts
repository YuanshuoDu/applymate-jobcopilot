import type { HarnessEvent } from "../types.js"

export type ScriptedEventBus = {
  publish(event: HarnessEvent): boolean
  disconnect(): void
  reconnect(): void
  isConnected(): boolean
  events(): readonly HarnessEvent[]
  replay(fromSequence?: number): readonly HarnessEvent[]
}

export function scriptedEventBus(): ScriptedEventBus {
  let connected = true
  const events: HarnessEvent[] = []
  const ids = new Set<string>()
  return {
    publish: (event) => {
      if (!connected || ids.has(event.id)) return false
      ids.add(event.id)
      events.push(event)
      return true
    },
    disconnect: () => { connected = false },
    reconnect: () => { connected = true },
    isConnected: () => connected,
    events: () => events.map(event => ({ ...event, payload: clone(event.payload) })),
    replay: (fromSequence = 0) => events.filter(event => event.sequence > fromSequence).map(event => ({ ...event, payload: clone(event.payload) })),
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
