import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { ToolExecutionError, type RuntimeToolDefinition } from "./types.js"
import { TURN_QUESTION_INTENT_SCHEMA, parseTurnQuestionArguments, type TurnQuestionIntentEnvelope } from "../turns/turn-question-contract.js"

const ChoiceSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200 }),
  value: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false })

export const AskUserInputSchema = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 8_000 }),
  choices: Type.Optional(Type.Array(ChoiceSchema, { maxItems: 6 })),
}, { additionalProperties: false })

const IntentOptionsSchema = Type.Array(ChoiceSchema, { maxItems: 6 })
export const AskUserOutputSchema = Type.Object({
  schemaVersion: Type.Literal(TURN_QUESTION_INTENT_SCHEMA),
  kind: Type.Literal("user_question"),
  stage: Type.Literal("user_input"),
  question: Type.String({ minLength: 1, maxLength: 8_000 }),
  options: IntentOptionsSchema,
}, { additionalProperties: false })

export type AskUserInput = Static<typeof AskUserInputSchema>
export type AskUserIntent = TurnQuestionIntentEnvelope

export function createAskUserTool(): RuntimeToolDefinition<AskUserInput, AskUserIntent> {
  return {
    schemaVersion, name: "agent.ask_user", version: "1",
    description: "Ask the user for missing information and pause this Turn until they answer.",
    capabilities: ["coordination"], inputSchema: AskUserInputSchema, outputSchema: AskUserOutputSchema,
    risk: "internal_write", domain: "coordination", idempotency: "idempotent", timeoutMs: 30_000,
    requiredCapabilities: ["canManageChildren"],
    async execute(context, value) {
      if (context.actorRole !== "orchestrator" || !context.taskId || context.rootTaskId !== context.taskId
        || !context.capabilities.includes("canManageChildren")) {
        throw new ToolExecutionError("ask_user_root_only", "Only the root agent can ask the user a question")
      }
      const input = parseTurnQuestionArguments(value)
      if (!input) throw new ToolExecutionError("ask_user_input_invalid", "The question or choices are invalid")
      return input
    },
  }
}
