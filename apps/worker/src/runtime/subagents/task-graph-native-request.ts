import { createHash } from "node:crypto"
import type { TaskGraphNativeCommandInput } from "./task-graph-native-command.js"
import { canonicalTaskGraphJson, taskGraphItemId } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

const MAX_JSON_BYTES = 32 * 1024
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 8_192

export type NormalizedNativeCommand = Readonly<{
  request: TaskGraphNativeCommandInput["request"] & Readonly<{
    constraints: readonly string[]
    successCriteria: readonly string[]
    context: unknown
  }>
  outputSchemaMarker: TaskGraphNativeCommandInput["outputSchemaMarker"] | null
  requestFingerprint: string
  operationId: string
  eventIdempotencyKey: string
}>

export function normalizeNativeCommand(input: TaskGraphNativeCommandInput): NormalizedNativeCommand {
  const row = object(input)
  if (!row || !exact(row, Object.hasOwn(row, "outputSchemaMarker") ? "outputSchemaMarker,request,scope" : "request,scope")) invalid()
  const source = object(row.request)
  if (!source || (source.kind !== "spawn" && source.kind !== "followup")) invalid()
  const required = source.kind === "spawn"
    ? "goal,idempotencyKey,kind,role,taskType"
    : "goal,idempotencyKey,kind,sourceTaskId"
  const optional = source.kind === "spawn"
    ? ["allowedActions", "constraints", "context", "parentTaskId", "successCriteria"]
    : ["constraints", "context", "successCriteria"]
  if (!hasRequiredOptionalKeys(source, required, optional) || !text(source.idempotencyKey, 256)
    || !text(source.goal, 4_000) || !stringList(source.constraints, 32, 1_000)
    || !stringList(source.successCriteria, 32, 1_000)
    || source.kind === "spawn" && !stringList(source.allowedActions, 32, 1_000)) invalid()
  const context = cloneJson(source.kind === "spawn" ? source.context ?? {} : source.context ?? null)
  const contextJson = canonicalTaskGraphJson(context)
  if (Buffer.byteLength(contextJson, "utf8") > MAX_JSON_BYTES) invalid()
  const marker = parseOutputSchemaMarker(row.outputSchemaMarker, source)
  const request = source.kind === "spawn"
    ? {
      kind: "spawn" as const, idempotencyKey: source.idempotencyKey as string,
      role: requiredText(source.role, 64), taskType: requiredText(source.taskType, 128), goal: source.goal as string,
      constraints: [...(source.constraints as string[] | undefined ?? [])],
      successCriteria: [...(source.successCriteria as string[] | undefined ?? [])],
      allowedActions: [...(source.allowedActions as string[] | undefined ?? [])], context,
      ...(source.parentTaskId === undefined ? {} : { parentTaskId: requiredText(source.parentTaskId, 256) }),
    }
    : {
      kind: "followup" as const, idempotencyKey: source.idempotencyKey as string,
      sourceTaskId: requiredText(source.sourceTaskId, 256), goal: source.goal as string,
      constraints: [...(source.constraints as string[] | undefined ?? [])],
      successCriteria: [...(source.successCriteria as string[] | undefined ?? [])], context,
    }
  const fingerprintPayload = { request, outputSchemaMarker: marker }
  const requestFingerprint = sha256(canonicalTaskGraphJson(fingerprintPayload))
  const scope = object(row.scope)
  if (!scope || !text(scope.userId, 256) || !text(scope.sessionId, 256) || !text(scope.turnId, 256) || !text(scope.rootTaskId, 256)) invalid()
  const operationId = `native-${sha256(canonicalTaskGraphJson([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, request.idempotencyKey])).slice(0, 48)}`
  const keyHash = sha256(request.idempotencyKey)
  return {
    request, outputSchemaMarker: marker, requestFingerprint, operationId,
    eventIdempotencyKey: `${taskGraphItemId(scope.rootTaskId)}:native:${keyHash}`,
  }
}

export function nativeContextMetrics(value: unknown): Readonly<{ contextDigest: string; contextBytes: number }> {
  const canonical = canonicalTaskGraphJson(value)
  const contextBytes = Buffer.byteLength(canonical, "utf8")
  if (contextBytes > MAX_JSON_BYTES) invalid()
  return { contextDigest: sha256(canonical), contextBytes }
}

function parseOutputSchemaMarker(value: unknown, request: Record<string, unknown>): NormalizedNativeCommand["outputSchemaMarker"] {
  if (value === undefined) return null
  const row = object(value)
  if (request.kind !== "spawn" || !row || !exact(row, "role,schemaVersion")
    || row.schemaVersion !== ROLE_RESULT_SCHEMA || (row.role !== "scout" && row.role !== "analyst")
    || row.role !== request.role) invalid()
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: row.role as "scout" | "analyst" }
}

function cloneJson(value: unknown, seen = new Set<object>(), depth = 0, budget = { nodes: 0 }): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) invalid()
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (!value || typeof value !== "object" || seen.has(value)) invalid()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) invalid()
      const result: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) invalid()
        result.push(cloneJson(value[index], seen, depth + 1, budget))
      }
      return result
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid()
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string")) invalid()
    const output: Record<string, unknown> = {}
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) invalid()
      Object.defineProperty(output, key, {
        value: cloneJson(descriptor.value, seen, depth + 1, budget), enumerable: true, writable: true, configurable: true,
      })
    }
    return output
  } finally { seen.delete(value) }
}

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0 ? value as Record<string, unknown> : null }
  catch { return null }
}
function exact(value: Record<string, unknown>, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function hasRequiredOptionalKeys(value: Record<string, unknown>, required: string, optional: readonly string[]): boolean {
  const requiredKeys = required.split(",")
  const keys = Object.keys(value)
  return requiredKeys.every(key => Object.hasOwn(value, key)) && keys.every(key => requiredKeys.includes(key) || optional.includes(key))
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max }
function requiredText(value: unknown, max: number): string { if (!text(value, max)) invalid(); return value }
function stringList(value: unknown, maxItems: number, maxLength: number): value is string[] | undefined {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > maxItems || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index) || !text(value[index], maxLength)) return false
  return true
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex") }
function invalid(): never { throw Object.assign(new Error("task_graph_native_input_invalid"), { code: "task_graph_native_input_invalid" }) }
