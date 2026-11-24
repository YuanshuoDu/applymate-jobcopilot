import { ApprovalStoreError } from "./types"

const RESERVED_SCHEMA_FAMILY = "objective-application-approval-set-member"

function reservedMemberEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const schema = Object.getOwnPropertyDescriptor(value, "schema")
    if (!schema) return false
    if (!("value" in schema)) return true
    return typeof schema.value === "string" && schema.value.startsWith(RESERVED_SCHEMA_FAMILY)
  } catch {
    return true
  }
}

/** Blocks grouped receipts from every generic single-approval operation. */
export function assertNotObjectiveApprovalSetMember(payload: unknown): void {
  if (reservedMemberEnvelope(payload)) {
    throw new ApprovalStoreError("approval_not_approved", "Approval receipt is no longer available")
  }
}
