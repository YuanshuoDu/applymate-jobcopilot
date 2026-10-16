import { createHash } from "node:crypto"

const KEY_PREFIX = "form-answer-v2-"
const TEXT_INPUT_TYPES = new Set(["text", "email", "tel", "url", "number", "date", "search"])

export function isAnswerableFormControl(tagName: string, type: string, multiple = false): boolean {
  if (tagName === "textarea") return true
  if (tagName === "select") return !multiple
  return tagName === "input" && TEXT_INPUT_TYPES.has(type.toLowerCase())
}

export function formAnswerKeyForSelector(id: string | null, name: string | null): string | null {
  const identity = id?.trim()
    ? JSON.stringify(["id", id.trim()])
    : name?.trim()
      ? JSON.stringify(["name", name.trim()])
      : null
  return identity ? formAnswerKeyForIdentity(identity) : null
}

function formAnswerKeyForIdentity(identity: string): string {
  const digest = createHash("sha256").update("applymate:" + KEY_PREFIX + "\0" + identity, "utf8").digest("hex")
  return KEY_PREFIX + digest
}

export function isFormAnswerKeyV2(value: string): boolean {
  return /^form-answer-v2-[a-f0-9]{64}$/.test(value)
}
