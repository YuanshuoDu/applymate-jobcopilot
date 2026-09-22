import type { PlanCommandExecutionRecord, PlanCommandExecutionResult, PlanCommandExecutionRuntime, PlanControlRecord } from "./plan-command-executor.js"
import type { PlanDispatchCommand } from "./plan-intent-dispatcher.js"

type ExecutableCommand = Extract<PlanDispatchCommand, { kind: "tool_call" | "delegate" | "join" }>
type ControlCommand = Extract<PlanDispatchCommand, { kind: "request_input" | "propose_completion" }>
const MAX_PARALLEL_DELEGATE_LIMIT = 4

export type PlanCommandExecutionStep = {
  readonly record: PlanCommandExecutionRecord
  readonly waiting: boolean
  readonly blocked?: PlanControlRecord
}

export type PlanCommandSchedulerRuntime = Pick<PlanCommandExecutionRuntime, "parallelDelegateLimit" | "admit" | "shouldAdmit"> & {
  readonly outputs: Map<string, unknown>
  readonly isReady?: (command: PlanDispatchCommand) => boolean
  readonly execute: (command: ExecutableCommand, outputs: ReadonlyMap<string, unknown>) => Promise<PlanCommandExecutionStep>
  readonly observe: (record: PlanCommandExecutionRecord | PlanControlRecord) => Promise<void>
  readonly storeOutput: (record: PlanCommandExecutionRecord) => void
  readonly invalidPlan: (message: string) => never
}

function admissionCount(commands: readonly ExecutableCommand[], runtime: PlanCommandSchedulerRuntime): number {
  return commands.reduce((count, command) => count + (runtime.shouldAdmit?.(command) === false ? 0 : 1), 0)
}

function admit(commands: readonly ExecutableCommand[], runtime: PlanCommandSchedulerRuntime): void {
  const count = admissionCount(commands, runtime)
  if (count > 0) runtime.admit?.(count)
}

function isControl(command: PlanDispatchCommand): command is ControlCommand {
  return command.kind === "request_input" || command.kind === "propose_completion"
}

function isExecutable(command: PlanDispatchCommand): command is ExecutableCommand {
  return command.kind === "tool_call" || command.kind === "delegate" || command.kind === "join"
}

function failed(completed: readonly PlanCommandExecutionRecord[], step: PlanCommandExecutionStep): PlanCommandExecutionResult {
  return { status: "failed", completed, failure: step.record }
}

async function executeSerial(commands: readonly PlanDispatchCommand[], runtime: PlanCommandSchedulerRuntime): Promise<PlanCommandExecutionResult> {
  validateGraph(commands, runtime)
  const completed: PlanCommandExecutionRecord[] = []
  const outputs = runtime.outputs
  const completedIds = new Set<string>()
  for (const command of commands) {
    if (!isReady(command, completedIds, runtime)) runtime.invalidPlan("Plan dependency graph is invalid")
    if (isControl(command)) {
      await runtime.observe(command)
      return { status: "blocked", completed, blocked: command }
    }
    if (!isExecutable(command)) runtime.invalidPlan("Plan executable command is invalid")
    admit([command], runtime)
    const step = await runtime.execute(command, outputs)
    await runtime.observe(step.record)
    if (step.record.result.status !== "completed") return failed(completed, step)
    runtime.storeOutput(step.record)
    if (step.waiting) return { status: "waiting", completed, waiting: step.record }
    completed.push(step.record)
    if (step.blocked) {
      await runtime.observe(step.blocked)
      return { status: "blocked", completed, blocked: step.blocked }
    }
    completedIds.add(command.localId)
  }
  return { status: "completed", completed }
}

type ReadyCommand = { readonly command: PlanDispatchCommand; readonly index: number }
type SettledStep = PromiseSettledResult<PlanCommandExecutionStep>

function isReady(command: PlanDispatchCommand, completedIds: ReadonlySet<string>, runtime: PlanCommandSchedulerRuntime): boolean {
  return runtime.isReady?.(command) ?? command.dependsOn.every(dependency => completedIds.has(dependency))
}

function ready(commands: readonly PlanDispatchCommand[], done: ReadonlySet<number>, completedIds: ReadonlySet<string>, runtime: PlanCommandSchedulerRuntime): ReadyCommand[] {
  return commands.flatMap((command, index) => done.has(index) || !isReady(command, completedIds, runtime) ? [] : [{ command, index }])
}

function validateGraph(commands: readonly PlanDispatchCommand[], runtime: PlanCommandSchedulerRuntime): void {
  const ids = new Set<string>()
  for (const command of commands) if (ids.has(command.localId)) runtime.invalidPlan("Plan local IDs must be unique"); else ids.add(command.localId)
  for (const command of commands) for (const dependency of command.dependsOn) if (!ids.has(dependency)) runtime.invalidPlan("Plan dependency graph is invalid")
  const indegree = new Map(commands.map(command => [command.localId, command.dependsOn.length]))
  const dependents = new Map<string, string[]>()
  for (const command of commands) for (const dependency of command.dependsOn) dependents.set(dependency, [...(dependents.get(dependency) ?? []), command.localId])
  const readyIds = commands.filter(command => indegree.get(command.localId) === 0).map(command => command.localId)
  let visited = 0
  for (let index = 0; index < readyIds.length; index++) {
    const localId = readyIds[index]!
    visited++
    for (const dependent of dependents.get(localId) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, next)
      if (next === 0) readyIds.push(dependent)
    }
  }
  if (visited !== commands.length) runtime.invalidPlan("Plan dependency graph is invalid")
}

async function observeSettled(
  entries: readonly { readonly command: ExecutableCommand; readonly settled: SettledStep }[],
  runtime: PlanCommandSchedulerRuntime,
): Promise<{ readonly steps: readonly PlanCommandExecutionStep[]; readonly observerError: unknown; readonly hasObserverError: boolean; readonly executionError: unknown; readonly hasExecutionError: boolean }> {
  const steps: PlanCommandExecutionStep[] = []
  let observerError: unknown
  let hasObserverError = false
  let executionError: unknown
  let hasExecutionError = false
  for (const entry of entries) {
    if (entry.settled.status === "rejected") {
      if (!hasExecutionError) { executionError = entry.settled.reason; hasExecutionError = true }
      continue
    }
    steps.push(entry.settled.value)
    try { await runtime.observe(entry.settled.value.record) } catch (error: unknown) { if (!hasObserverError) { observerError = error; hasObserverError = true } }
  }
  return { steps, observerError, hasObserverError, executionError, hasExecutionError }
}

async function executeBatch(batch: readonly ReadyCommand[], runtime: PlanCommandSchedulerRuntime, completed: PlanCommandExecutionRecord[], outputs: Map<string, unknown>, done: Set<number>, completedIds: Set<string>): Promise<PlanCommandExecutionResult | undefined> {
  admit(batch.map(entry => entry.command as ExecutableCommand), runtime)
  const settled = await Promise.allSettled(batch.map(entry => Promise.resolve().then(() => runtime.execute(entry.command as ExecutableCommand, outputs))))
  const entries = batch.map((entry, index) => ({ command: entry.command as ExecutableCommand, settled: settled[index]! }))
  const observed = await observeSettled(entries, runtime)
  if (observed.hasObserverError) throw observed.observerError
  if (observed.hasExecutionError) throw observed.executionError
  const firstTerminal = observed.steps.findIndex(step => step.record.result.status !== "completed" || step.waiting || step.blocked)
  const terminal = firstTerminal >= 0 ? observed.steps[firstTerminal]! : undefined
  const terminalWaits = terminal !== undefined && terminal.record.result.status === "completed" && (terminal.waiting || terminal.blocked)
  const terminalIndex = firstTerminal < 0 ? observed.steps.length : firstTerminal
  for (let index = 0; index < terminalIndex; index++) {
    const step = observed.steps[index]!
    runtime.storeOutput(step.record)
    completed.push(step.record)
    const entry = batch.find(candidate => candidate.command.localId === step.record.localId)
    if (entry) { done.add(entry.index); completedIds.add(entry.command.localId) }
  }
  if (firstTerminal >= 0) {
    if (!terminal) return undefined
    if (terminalWaits) {
      if (terminal.record.result.status === "completed") {
        runtime.storeOutput(terminal.record)
        if (terminal.blocked) completed.push(terminal.record)
      }
      for (let index = firstTerminal + 1; index < observed.steps.length; index++) {
        const step = observed.steps[index]!
        if (step.record.result.status !== "completed" || step.waiting || step.blocked) continue
        runtime.storeOutput(step.record)
        completed.push(step.record)
        const entry = batch.find(candidate => candidate.command.localId === step.record.localId)
        if (entry) { done.add(entry.index); completedIds.add(entry.command.localId) }
      }
    }
    if (terminal.blocked) {
      if (terminal.record.result.status !== "completed") return failed(completed, terminal)
      await runtime.observe(terminal.blocked)
      return { status: "blocked", completed, blocked: terminal.blocked }
    }
    if (terminal.record.result.status !== "completed") return failed(completed, terminal)
    return { status: "waiting", completed, waiting: terminal.record }
  }
  for (const entry of batch) { done.add(entry.index); completedIds.add(entry.command.localId) }
  return undefined
}

async function executeParallel(commands: readonly PlanDispatchCommand[], runtime: PlanCommandSchedulerRuntime): Promise<PlanCommandExecutionResult> {
  validateGraph(commands, runtime)
  const completed: PlanCommandExecutionRecord[] = []
  const outputs = runtime.outputs
  const done = new Set<number>()
  const completedIds = new Set<string>()
  const limit = runtime.parallelDelegateLimit ?? 1

  while (done.size < commands.length) {
    const candidates = ready(commands, done, completedIds, runtime)
    if (candidates.length === 0) runtime.invalidPlan("Plan dependency graph is invalid")
    const first = candidates[0]!
    if (isControl(first.command)) {
      await runtime.observe(first.command)
      return { status: "blocked", completed, blocked: first.command }
    }
    if (!isExecutable(first.command)) runtime.invalidPlan("Plan executable command is invalid")
    const barrier = candidates.find(entry => entry.command.kind !== "delegate")?.index ?? Number.POSITIVE_INFINITY
    const batch = first.command.kind === "delegate" && first.command.inputRefs.length === 0
      ? candidates.filter(entry => entry.index < barrier && entry.command.kind === "delegate" && entry.command.inputRefs.length === 0).slice(0, limit)
      : []
    if (batch.length > 1) {
      const outcome = await executeBatch(batch, runtime, completed, outputs, done, completedIds)
      if (outcome) return outcome
      continue
    }
    admit([first.command], runtime)
    const step = await runtime.execute(first.command, outputs)
    await runtime.observe(step.record)
    if (step.record.result.status !== "completed") return failed(completed, step)
    runtime.storeOutput(step.record)
    if (step.waiting) return { status: "waiting", completed, waiting: step.record }
    completed.push(step.record)
    if (step.blocked) {
      await runtime.observe(step.blocked)
      return { status: "blocked", completed, blocked: step.blocked }
    }
    done.add(first.index)
    completedIds.add(first.command.localId)
  }
  return { status: "completed", completed }
}

export async function schedulePlanCommands(commands: readonly PlanDispatchCommand[], runtime: PlanCommandSchedulerRuntime): Promise<PlanCommandExecutionResult> {
  const limit = runtime.parallelDelegateLimit
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PARALLEL_DELEGATE_LIMIT)) runtime.invalidPlan("Plan parallel delegate bound is invalid")
  return runtime.parallelDelegateLimit === undefined ? executeSerial(commands, runtime) : executeParallel(commands, runtime)
}
