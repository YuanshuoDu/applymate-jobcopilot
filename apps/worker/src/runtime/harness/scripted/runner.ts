import { SideEffectLedger } from "./ledger.js"
import { createSeededRandom, resolveHarnessSeed } from "./seed.js"
import { scriptedClock, type ScriptedClock } from "./adapters/clock.js"
import { scriptedEventBus, type ScriptedEventBus } from "./adapters/event-bus.js"
import { scriptedModel, type ScriptedModel } from "./adapters/model.js"
import { scriptedTool, type ScriptedTool } from "./adapters/tool.js"
import type { HarnessEvent, HarnessMessage, HarnessState, FaultPoint, JsonValue, ScriptedModelStep } from "./types.js"
import type { HarnessTrace, HarnessTraceStep } from "./trace.js"

export type ScriptedTurn = {
  readonly goal: string
  readonly model: ScriptedModel
  readonly tool?: ScriptedTool
  readonly approval?: "approved" | "rejected"
  readonly fault?: FaultPoint
  readonly stopAt?: number
}

export type ScriptedHarnessOptions = {
  readonly scenario: string
  readonly seed?: number
  readonly sessionId?: string
  readonly clock?: ScriptedClock
  readonly bus?: ScriptedEventBus
  readonly ledger?: SideEffectLedger
}

export type ScriptedTurnResult = {
  readonly status: HarnessState["status"]
  readonly errorCode: string | null
  readonly state: HarnessState
}

export class ScriptedHarness {
  readonly clock: ScriptedClock
  readonly bus: ScriptedEventBus
  readonly ledger: SideEffectLedger
  readonly seed: number
  private readonly random: ReturnType<typeof createSeededRandom>
  private readonly scenario: string
  private readonly traceSteps: HarnessTraceStep[] = []
  private readonly traceEvents: HarnessEvent[] = []
  private state: MutableState

  constructor(options: ScriptedHarnessOptions) {
    this.seed = options.seed ?? resolveHarnessSeed()
    this.random = createSeededRandom(this.seed)
    this.clock = options.clock ?? scriptedClock({ start: "2026-01-01T00:00:00.000Z", advance: 25 })
    this.bus = options.bus ?? scriptedEventBus()
    this.ledger = options.ledger ?? new SideEffectLedger(() => this.clock.nowIso())
    this.scenario = options.scenario
    this.state = initialState(options.sessionId ?? `session-${this.seed}`)
  }

  async runTurn(turn: ScriptedTurn): Promise<ScriptedTurnResult> {
    const turnId = `${this.state.sessionId}:turn-${this.state.turnCount + 1}`
    this.state = { ...this.state, turnId, turnCount: this.state.turnCount + 1, status: "working", errorCode: null, finalResponse: null }
    this.publish("turn.started", { goal: turn.goal, turnId })
    this.message("user", turn.goal)
    let stepIndex = 0
    let completed = false
    let sawStep = false
    while (true) {
      const step = turn.model.next(stepIndex, this.clock.now().getTime() - this.clock.startMs)
      if (!step) {
        const pending = turn.model.steps[stepIndex]
        if (pending && typeof pending.at !== "number") {
          const elapsedMs = this.clock.now().getTime() - this.clock.startMs
          this.clock.advance(Math.max(0, pending.at.timeMs - elapsedMs))
          continue
        }
        break
      }
      sawStep = true
      this.traceSteps.push(this.traceStep(stepIndex, step, { status: this.state.status }))
      if (turn.stopAt === stepIndex) {
        this.stop()
        break
      }
      if (turn.fault && this.injectFault(turn.fault, stepIndex, turnId)) break
      const result = await this.applyModelEvent(step, turn, turnId)
      if (result === "terminal") { completed = this.state.status === "completed"; break }
      stepIndex += 1
    }
    if (!sawStep && this.state.status === "working") this.state = { ...this.state, status: "empty_session" }
    else if (!completed && this.state.status === "working") this.fail("model_incomplete")
    if (this.state.status === "waiting_for_approval" && turn.approval) {
      this.resolveApproval(turn.approval, turnId)
      completed = turn.approval === "approved"
    }
    if (!this.hasTurnLedger("approval.consume", turnId)) this.ledger.record("approval.consume", `${turnId}:not-required`, { decision: "not_required" })
    if (!this.hasTurnLedger("tool.execution", turnId)) this.ledger.record("tool.execution", `${turnId}:not-required`, { status: "not_required" })
    this.publish("turn.completed", { turnId, status: this.state.status, errorCode: this.state.errorCode, finalResponse: this.state.finalResponse })
    this.ledger.record("artifact.write", `${turnId}:summary`, { turnId, status: this.state.status })
    this.ledger.record("turn.complete", turnId, { status: this.state.status, errorCode: this.state.errorCode })
    return { status: this.state.status, errorCode: this.state.errorCode, state: this.snapshot() }
  }

  async runSession(turns: readonly ScriptedTurn[]): Promise<HarnessState> {
    for (const turn of turns) await this.runTurn(turn)
    return this.snapshot()
  }

  trace(): HarnessTrace {
    const events = this.bus.events()
    return {
      schemaVersion: "agent-harness.v2.scripted-trace",
      scenario: this.scenario,
      seed: this.seed,
      wallClock: { start: new Date(this.clock.startMs).toISOString(), end: this.clock.nowIso() },
      steps: this.traceSteps,
      events,
      ledger: this.ledger.snapshot(),
      finalState: this.snapshot(),
    }
  }

  private async applyModelEvent(step: ScriptedModelStep, turn: ScriptedTurn, turnId: string): Promise<"continue" | "terminal"> {
    const event = step.event
    if (event.type === "text") { this.message("assistant", event.text); return "continue" }
    if (event.type === "tool_call") {
      const tool = turn.tool ?? scriptedTool({ name: event.name, response: { ok: true, result: "scripted" } })
      try {
        const response = await tool.execute(event.input, { clock: this.clock, timeoutMs: turn.fault === "tool_timeout" ? 0 : undefined })
        this.ledger.record("tool.execution", `${turnId}:${event.callId}`, { callId: event.callId, name: event.name, response })
        if (turn.fault === "idempotency_race") {
          const replayResponse = await tool.execute(event.input, { clock: this.clock })
          this.ledger.record("tool.execution", `${turnId}:${event.callId}`, { callId: event.callId, name: event.name, response: replayResponse })
        }
      } catch (error: unknown) {
        this.ledger.record("tool.execution", `${turnId}:${event.callId}`, { callId: event.callId, name: event.name, error: errorCode(error) })
        this.fail(errorCode(error))
        return "terminal"
      }
      return "continue"
    }
    if (event.type === "approval_request") {
      this.state = { ...this.state, status: "waiting_for_approval" }
      this.publish("approval.requested", { approvalId: event.approvalId, action: event.action })
      return "terminal"
    }
    if (event.type === "final") {
      this.message("assistant", event.text)
      this.state = { ...this.state, status: "completed", finalResponse: event.text }
      this.publish("turn.final", { turnId, text: event.text })
      return "terminal"
    }
    if (event.type === "v1_banner") { this.message("system", event.text); return "continue" }
    if (event.type === "unknown_event") {
      this.state = { ...this.state, unknownEvents: this.state.unknownEvents + 1 }
      this.publish("protocol.unknown_event", { name: event.name, payload: event.payload })
      return "continue"
    }
    this.state = { ...this.state, unknownTypes: this.state.unknownTypes + 1 }
    this.publish("protocol.unknown_type", { name: event.name, payload: event.payload })
    return "continue"
  }

  private injectFault(fault: FaultPoint, stepIndex: number, turnId: string): boolean {
    if (stepIndex !== 0) return false
    this.publish("fault.injected", { fault, stepIndex })
    if (fault === "network_drop") {
      this.bus.disconnect()
      this.state = { ...this.state, status: "reconnected" }
      this.bus.reconnect()
      this.publish("stream.reconnected", { turnId, replayedFrom: this.state.lastEventId })
      return false
    }
    if (fault === "duplicate_event") {
      const duplicate = this.traceEvents.at(-1)
      if (duplicate) this.bus.publish(duplicate)
      return false
    }
    if (fault === "idempotency_race") return false
    if (fault === "tool_timeout") return false
    if (fault === "partial_turn") {
      this.message("assistant", "Partial scripted output")
      this.fail(fault)
      return true
    }
    const code = fault === "abort" ? "aborted" : fault
    this.fail(code)
    return true
  }

  private resolveApproval(decision: "approved" | "rejected", turnId: string): void {
    this.ledger.record("approval.consume", `${turnId}:approval`, { decision })
    this.publish("approval.resolved", { decision, response: decision === "approved" ? "Approved scripted completion" : null })
    this.state = { ...this.state, status: decision === "approved" ? "completed" : "interrupted", finalResponse: decision === "approved" ? "Approved scripted completion" : null }
  }

  stop(reason = "interrupt_requested"): void {
    if (this.state.status !== "working") return
    this.state = { ...this.state, status: "interrupted", errorCode: reason }
    this.publish("turn.interrupted", { code: reason })
  }

  private publish(type: string, payload: JsonValue): void {
    const sequence = this.state.eventSequence + 1
    const event: HarnessEvent = { id: `event-${sequence}-${this.random.integer(1_000_000)}`, sequence, type, at: this.clock.nowIso(), payload }
    if (!this.bus.publish(event)) return
    this.traceEvents.push(event)
    this.state = { ...this.state, eventSequence: event.sequence, lastEventId: event.id }
    this.ledger.record("event.publish", event.id, { type, sequence: event.sequence })
  }

  private traceStep(index: number, step: ScriptedModelStep, input: JsonValue): HarnessTraceStep {
    return { index, at: step.at, input, output: step.event as unknown as JsonValue }
  }

  private message(role: HarnessMessage["role"], text: string): void {
    this.state = { ...this.state, messages: [...this.state.messages, { role, text }] }
    this.publish("message.appended", { role, text })
  }

  private fail(code: string): void {
    this.state = { ...this.state, status: code === "aborted" ? "interrupted" : "failed", errorCode: code }
    this.publish("turn.failed", { code })
  }

  private hasTurnLedger(type: string, turnId: string): boolean {
    return this.ledger.snapshot().some(entry => entry.type === type && entry.key.startsWith(`${turnId}:`))
  }

  private snapshot(): HarnessState {
    return { ...this.state, messages: this.state.messages.map(message => ({ ...message })) }
  }
}

type MutableState = {
  sessionId: string
  turnId: string | null
  status: HarnessState["status"]
  turnCount: number
  eventSequence: number
  lastEventId: string | null
  messages: HarnessMessage[]
  finalResponse: string | null
  errorCode: string | null
  externalWrites: number
  unknownEvents: number
  unknownTypes: number
}

function initialState(sessionId: string): MutableState {
  return { sessionId, turnId: null, status: "ready", turnCount: 0, eventSequence: 0, lastEventId: null, messages: [], finalResponse: null, errorCode: null, externalWrites: 0, unknownEvents: 0, unknownTypes: 0 }
}
function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "tool_execution_failed"
}
