import type { TurnBudgetLimits } from "../budget.js"

export type TreeBudgetReservationStatus = "reserved" | "consumed" | "released"
export type TreeBudgetExecutionLimits = Pick<TurnBudgetLimits, "maxSteps" | "maxToolCalls">

export type TreeBudgetRootIdentity = {
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
}

export type TreeBudgetReservation = {
  id: string
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  taskId: string
  stepId: string
  attempt: number
  units: 1
  status: TreeBudgetReservationStatus
  idempotencyKey: string
  createdAt: Date
  updatedAt: Date
  settledAt: Date | null
}

export type TreeBudgetReserveInput = {
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  taskId: string
  stepId: string
  attempt: number
  idempotencyKey: string
  now?: Date
}

export type TreeBudgetSettleInput = Omit<TreeBudgetReserveInput, "now" | "idempotencyKey"> & {
  id: string
  idempotencyKey: string
  status: Exclude<TreeBudgetReservationStatus, "reserved">
  now?: Date
}

export type TreeBudgetReservationStore = {
  reserve(input: TreeBudgetReserveInput): Promise<TreeBudgetReservation>
  settle(input: TreeBudgetSettleInput): Promise<TreeBudgetReservation>
  /** Reads only root step and tool-call ceilings; aggregate enforcement remains durable. */
  readRootLimits?(input: TreeBudgetRootIdentity): Promise<TreeBudgetExecutionLimits | undefined>
}
