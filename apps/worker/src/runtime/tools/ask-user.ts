import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { ToolExecutionError, type RuntimeToolDefinition } from "./types.js"
import { TURN_QUESTION_INTENT_SCHEMA, parseTurnQuestionArguments, type TurnQuestionIntentEnvelope } from "../turns/turn-question-contract.js"

const ChoiceTextSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  description: "Maximum 200 UTF-8 bytes. JSON Schema maxLength caps characters at 200; server-side validation enforces the exact UTF-8 byte limit.",
})

const ChoiceSchema = Type.Object({
  label: ChoiceTextSchema,
  value: ChoiceTextSchema,
}, { additionalProperties: false })

const QuestionTextSchema = Type.String({
  minLength: 1,
  maxLength: 2_000,
  description: "Maximum 2,000 UTF-8 bytes. JSON Schema maxLength caps characters at 2,000; server-side validation enforces the exact UTF-8 byte limit.",
})

export const AskUserInputSchema = Type.Object({
  question: QuestionTextSchema,
  choices: Type.Optional(Type.Array(ChoiceSchema, { maxItems: 6 })),
}, { additionalProperties: false })

const IntentOptionsSchema = Type.Array(ChoiceSchema, { maxItems: 6 })
export const AskUserOutputSchema = Type.Object({
  schemaVersion: Type.Literal(TURN_QUESTION_INTENT_SCHEMA),
  kind: Type.Literal("user_question"),
  stage: Type.Literal("user_input"),
  question: QuestionTextSchema,
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
