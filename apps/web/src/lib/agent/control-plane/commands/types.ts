import type { InputContentPart, TurnSource } from "@jobcopilot/agent-protocol"

export const COMMAND_DISPOSITIONS = [
  "started",
  "steered",
  "queued_follow_up",
  "duplicate",
] as const

export type CommandDisposition = (typeof COMMAND_DISPOSITIONS)[number]
export type InterruptDisposition = "interrupted" | "duplicate"

export interface CommandIdentity {
  sessionId: string
  userId: string
  clientMessageId: string
  source: TurnSource
}

export interface StartCommand extends CommandIdentity {
  content: InputContentPart[]
}

export interface MessageCommand extends CommandIdentity {
  content: InputContentPart[]
  delivery: "steer" | "follow_up"
  expectedTurnId?: string | null
  expectedRevision?: number | null
}

export interface SteerCommand extends CommandIdentity {
  content: InputContentPart[]
  expectedTurnId: string | null
  expectedRevision?: number | null
}

export interface InterruptCommand extends CommandIdentity {
  expectedTurnId: string | null
  expectedRevision?: number | null
}

export interface CommandResult {
  inputId: string
  turnId: string
  disposition: CommandDisposition
  originalDisposition?: Exclude<CommandDisposition, "duplicate">
  sequence: string
}

export interface InterruptResult {
  inputId: string
  turnId: string
  disposition: InterruptDisposition
  originalDisposition?: "interrupted"
  sequence: string
}
