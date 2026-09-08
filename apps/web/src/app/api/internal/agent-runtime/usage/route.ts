import { NextRequest, NextResponse } from "next/server"
import { loadWorkerAiConfig } from "@jobcopilot/shared/llm"

import { resolveAiAccess } from "@/lib/entitlements"
import { db } from "@/lib/db"
import {
  admitAiUsage,
  settleAiUsage,
  UsageBrokerError,
  type UsageAdmissionInput,
  type UsageSettlementInput,
} from "@/lib/agent/control-plane/usage-broker"

type RequestBody =
  | { operation: "authorize"; input: UsageAdmissionInput }
  | { operation: "settle"; input: UsageSettlementInput }

function authorized(request: NextRequest): boolean {
  const secret = process.env.AGENT_WORKER_SECRET
  return Boolean(secret) && request.headers.get("x-agent-worker-secret") === secret
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function parseInput(value: unknown): RequestBody | null {
  const row = record(value)
  if (!row || (row.operation !== "authorize" && row.operation !== "settle")) return null
  const input = record(row.input)
  if (!input || !text(input.userId) || !text(input.provider) || !text(input.model)) return null
  if (row.operation === "authorize") {
    if (!text(input.sessionId) || !text(input.turnId) || !text(input.stepId) || !text(input.leaseOwnerId) ||
        !Number.isSafeInteger(input.leaseVersion) || Number(input.leaseVersion) < 0 || !text(input.featureKey)) return null
    return { operation: "authorize", input: {
      userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId,
      leaseOwnerId: input.leaseOwnerId, leaseVersion: Number(input.leaseVersion), featureKey: input.featureKey,
      provider: input.provider, model: input.model, ...(text(input.attemptId) ? { attemptId: input.attemptId } : {}),
    } }
  }
  if (!text(input.operationId) || (input.status !== "success" && input.status !== "error") ||
      !finite(input.inputTokens) || !finite(input.outputTokens) || !finite(input.estimatedCostUsd)) return null
  return { operation: "settle", input: {
    operationId: input.operationId, userId: input.userId, provider: input.provider, model: input.model,
    status: input.status, inputTokens: input.inputTokens, outputTokens: input.outputTokens,
    estimatedCostUsd: input.estimatedCostUsd, ...(text(input.errorCode) ? { errorCode: input.errorCode } : {}),
  } }
}

function failure(error: unknown): NextResponse {
  if (error instanceof UsageBrokerError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status })
  return NextResponse.json({ error: "usage_broker_unavailable", code: "usage_broker_unavailable" }, { status: 503 })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = parseInput(await request.json().catch(() => null))
  if (!body) return NextResponse.json({ error: "Invalid usage request" }, { status: 400 })

  try {
    if (body.operation === "settle") {
      await settleAiUsage(db, body.input)
      return NextResponse.json({ status: "settled" })
    }
    const access = await resolveAiAccess(body.input.userId)
    if (access === "disabled") return NextResponse.json({ error: "ai_credits_disabled", code: "ai_credits_disabled" }, { status: 403 })
    if (access === "exhausted") return NextResponse.json({ error: "ai_credits_exhausted", code: "ai_credits_exhausted" }, { status: 429 })
    const trusted = await loadWorkerAiConfig(body.input.userId)
    if (trusted.provider !== body.input.provider || trusted.model !== body.input.model) {
      return NextResponse.json({ error: "model_not_authorized", code: "model_not_authorized" }, { status: 403 })
    }
    const result = await admitAiUsage(db, {
      ...body.input,
      // loadWorkerAiConfig resolves whether the trusted route uses the
      // platform credential or a user-owned key; never accept this from the Worker.
      credentialSource: trusted.credentialSource ?? (trusted.apiKey ? "user" : "platform"),
    })
    return NextResponse.json({ status: "authorized", operationId: result.operationId })
  } catch (error: unknown) {
    return failure(error)
  }
}
