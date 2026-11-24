import { Prisma, type PrismaClient } from "@prisma/client"
import {
  OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT,
  parseObjectiveApplicationReviewIntent,
  parseObjectiveTailorGraph,
  type ObjectiveApplicationReviewIntent,
} from "@jobcopilot/agent-protocol"

import { duplicateCommandResult } from "./agent-command-service"
import { invalidCommand, isUniqueViolation, retryActiveConflict, turnNotActive } from "./errors"
import {
  acceptInputFacts,
  createRootTurn,
  findActiveTurn,
  findExistingCommand,
  lockOpenSession,
  type CommandTransaction,
} from "./transaction"
import type { CommandIdentity, CommandResult } from "./types"

const GOAL = "Review the selected completed Objective materials for application preparation."
const CONTENT = [{ type: "text" as const, text: "Review the selected verified materials. This does not authorize an application or submission." }]
type Command = CommandIdentity & Readonly<{ selection: ObjectiveApplicationReviewIntent }>
type Row = Record<string, unknown>
type SourceRow = Row & Readonly<{
  id: string; rootTaskId: string; turnStatus: string; turnSource: string; executionMode: string
  rootStatus: string; rootRole: string; rootTaskType: string; rootDepth: number
}>
type GraphRow = Row & Readonly<{ id: string; revision: number; content: unknown }>
const TURN_INTENT_KEYS = ["kind", "selection", "version"] as const
const COMMAND_KEYS = ["clientMessageId", "selection", "sessionId", "userId"] as const
const INPUT_KEYS = ["clientMessageId", "content", "goal", "intent"] as const

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    if (keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return null
    return value as Row
  } catch { return null }
}

function exact(value: unknown, keys: readonly string[]): Row | null {
  const row = record(value)
  if (!row) return null
  const actual = Reflect.ownKeys(row)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)) ? row : null
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function parseCommand(value: unknown): Command {
  const input = exact(value, COMMAND_KEYS), selection = parseObjectiveApplicationReviewIntent(input?.selection)
  if (!input || !identity(input.userId) || !identity(input.sessionId) || !identity(input.clientMessageId) || !selection) {
    throw invalidCommand("Objective application review command is invalid")
  }
  return { userId: input.userId, sessionId: input.sessionId, clientMessageId: input.clientMessageId, source: "user", selection }
}

function reviewIntent(selection: ObjectiveApplicationReviewIntent) {
  return { ...OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT, selection: { ...selection, slotOrdinals: [...selection.slotOrdinals] } }
}

function sameSelection(left: ObjectiveApplicationReviewIntent, right: ObjectiveApplicationReviewIntent): boolean {
  return left.schema === right.schema && left.sourceTurnId === right.sourceTurnId && left.rootTaskId === right.rootTaskId
    && left.graphItemId === right.graphItemId && left.graphRevision === right.graphRevision
    && left.slotOrdinals.length === right.slotOrdinals.length
    && left.slotOrdinals.every((ordinal, index) => ordinal === right.slotOrdinals[index])
}

function duplicateMatches(value: unknown, command: Command): boolean {
  const input = exact(value, INPUT_KEYS), intent = exact(input?.intent, TURN_INTENT_KEYS)
  const saved = parseObjectiveApplicationReviewIntent(intent?.selection)
  return !!input && input.clientMessageId === command.clientMessageId && !Object.hasOwn(input, "selectedJobPreparation")
    && intent?.kind === OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT.kind && intent.version === OBJECTIVE_APPLICATION_REVIEW_TURN_INTENT.version
    && !!saved && sameSelection(saved, command.selection)
}

async function duplicate(tx: CommandTransaction, command: Command, identity: CommandIdentity,
  existing: NonNullable<Awaited<ReturnType<typeof findExistingCommand>>>): Promise<CommandResult> {
  if (!existing.targetTurnId) throw turnNotActive(null)
  const turn = await tx.agentTurn.findFirst({ where: { id: existing.targetTurnId, sessionId: command.sessionId,
    userId: command.userId, source: "user" }, select: { input: true, executionMode: true } })
  if (turn?.executionMode !== "canonical_task_graph" || !duplicateMatches(turn.input, command)) {
    throw invalidCommand("Client message ID is already bound to a different Objective review")
  }
  return duplicateCommandResult(tx, identity, existing, "follow_up")
}

async function assertCompletedSource(tx: CommandTransaction, command: Command): Promise<void> {
  const selection = command.selection
  const sourceRows = await tx.$queryRaw<SourceRow[]>(Prisma.sql`
    SELECT source."id", source."rootTaskId", source."status" AS "turnStatus", source."source" AS "turnSource",
      source."executionMode", root."status" AS "rootStatus", root."role" AS "rootRole",
      root."taskType" AS "rootTaskType", root."depth" AS "rootDepth"
    FROM "agent_turns" AS source
    JOIN "agent_sessions" AS session ON session."id" = source."sessionId" AND session."userId" = source."userId"
    JOIN "sub_agent_tasks" AS root ON root."id" = source."rootTaskId" AND root."sessionId" = source."sessionId"
      AND root."turnId" = source."id" AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
    WHERE source."id" = ${selection.sourceTurnId} AND source."sessionId" = ${command.sessionId}
      AND source."userId" = ${command.userId} AND source."source" = 'user'
      AND source."executionMode" = 'canonical_task_graph' AND source."status" = 'completed'
      AND source."rootTaskId" = ${selection.rootTaskId} AND root."status" = 'completed'
      AND root."role" = 'orchestrator' AND root."taskType" = 'root' AND root."depth" = 0
      AND session."status" NOT IN ('aborted', 'archived')
    FOR SHARE OF source, root
  `)
  const source = sourceRows[0]
  if (sourceRows.length !== 1 || source?.id !== selection.sourceTurnId || source.rootTaskId !== selection.rootTaskId
    || source.turnStatus !== "completed" || source.turnSource !== "user" || source.executionMode !== "canonical_task_graph"
    || source.rootStatus !== "completed" || source.rootRole !== "orchestrator" || source.rootTaskType !== "root" || source.rootDepth !== 0) {
    throw invalidCommand("Objective source is not a completed owned canonical Turn")
  }
  const graphRows = await tx.$queryRaw<GraphRow[]>(Prisma.sql`
    SELECT item."id", item."revision", item."content"
    FROM "agent_items" AS item
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    WHERE item."id" = ${selection.graphItemId} AND item."sessionId" = ${command.sessionId}
      AND item."turnId" = ${selection.sourceTurnId} AND item."taskId" = ${selection.rootTaskId}
      AND item."type" = 'task_graph' AND session."userId" = ${command.userId}
    FOR SHARE OF item
  `)
  const graph = record(graphRows[0]?.content), marker = graph && parseObjectiveTailorGraph(graph.objectiveTailor, graph.nodes)
  if (graphRows.length !== 1 || graphRows[0]?.id !== selection.graphItemId
    || Number(graphRows[0]?.revision) !== selection.graphRevision || !Number.isSafeInteger(Number(graphRows[0]?.revision))
    || !graph || graph.schemaVersion !== "agent-harness.v2.task-graph" || !marker
    || selection.slotOrdinals.some(ordinal => marker.slots[ordinal - 1]?.slotId !== `tailor-${ordinal}`)) {
    throw invalidCommand("Objective source graph or selected slot changed")
  }
}

async function startOnce(command: Command, db: PrismaClient): Promise<CommandResult> {
  const identity: CommandIdentity = { sessionId: command.sessionId, userId: command.userId,
    clientMessageId: command.clientMessageId, source: "user" }
  return db.$transaction(async tx => {
    await lockOpenSession(tx, identity.sessionId, identity.userId)
    const existing = await findExistingCommand(tx, identity.sessionId, identity.clientMessageId)
    if (existing) return duplicate(tx, command, identity, existing)
    const active = await findActiveTurn(tx, identity.sessionId, identity.userId)
    if (active) throw retryActiveConflict(active.id)
    await assertCompletedSource(tx, command)
    const turn = await createRootTurn(tx, identity, CONTENT, GOAL, undefined, reviewIntent(command.selection))
    const facts = await acceptInputFacts(tx, identity, CONTENT, turn, "follow_up", "started", true)
    return { ...facts, disposition: "started" }
  })
}

export class ObjectiveApplicationReviewCommandService {
  constructor(private readonly db: PrismaClient) {}

  async start(value: unknown): Promise<CommandResult> {
    const command = parseCommand(value)
    try { return await startOnce(command, this.db) }
    catch (error: unknown) { if (!isUniqueViolation(error)) throw error; return startOnce(command, this.db) }
  }
}
