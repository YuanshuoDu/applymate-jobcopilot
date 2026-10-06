import type pg from "pg"
import { createPgTurnQuestionStore } from "./turn-question-store.js"
import type { TurnQuestionStore } from "./turn-question-contract.js"

type QuestionPool = Pick<pg.Pool, "connect">

export function attachTurnQuestionStore<T extends object>(base: T, pool: QuestionPool): T & TurnQuestionStore {
  return Object.assign(base, createPgTurnQuestionStore(pool))
}
