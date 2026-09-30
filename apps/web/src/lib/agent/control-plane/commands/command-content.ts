import type { InputContentPart } from "@jobcopilot/agent-protocol"

import { invalidCommand } from "./errors"

type CommandEvent = { sequence: bigint; payload: unknown }
type OriginalDisposition = "started" | "steered" | "queued_follow_up" | "interrupted"

export function assertContent(content: InputContentPart[]): void {
  if (content.length === 0) {
    throw invalidCommand("Agent commands require at least one content part")
  }
}

export function dispositionFromEvent(event: CommandEvent | null, fallback: OriginalDisposition): OriginalDisposition {
  if (typeof event?.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return fallback
  const value = (event.payload as { disposition?: unknown }).disposition
  return typeof value === "string" && ["started", "steered", "queued_follow_up", "interrupted"].includes(value)
    ? (value as OriginalDisposition)
    : fallback
}
