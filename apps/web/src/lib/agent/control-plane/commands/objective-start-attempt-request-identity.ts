import { createHash } from "node:crypto"
import { canonicalJson } from "@jobcopilot/shared"

import type { ObjectiveStartCommand } from "./types"

type AttemptIdentity = Pick<ObjectiveStartCommand, "userId" | "clientMessageId" | "sessionId" | "objective" | "content" | "verificationRequirements">

function persistedCanonicalJson(value: unknown): string {
  const persisted = JSON.parse(JSON.stringify(value) ?? "null")
  return canonicalJson(persisted)
}

export function samePersistedJson(left: unknown, right: unknown): boolean {
  try {
    return persistedCanonicalJson(left) === persistedCanonicalJson(right)
  } catch {
    return false
  }
}

export function objectiveStartRequestHash(command: AttemptIdentity): string {
  const hasRequirements = Object.hasOwn(command, "verificationRequirements")
  const canonical = {
    sessionId: command.sessionId,
    objective: command.objective.trim(),
    content: command.content,
    verificationRequirements: hasRequirements
      ? { present: true, value: command.verificationRequirements ?? null }
      : { present: false },
  }
  return createHash("sha256").update(persistedCanonicalJson(canonical)).digest("hex")
}
