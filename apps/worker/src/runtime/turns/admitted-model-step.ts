import type { TurnExecutionEventWriter } from "./turn-execution-events.js"

export async function runAdmittedModelStep<T>(input: {
  readonly writer: Pick<TurnExecutionEventWriter, "append">
  readonly stepId: string
  readonly taskId?: string
  readonly provider: string
  readonly model: string
  readonly invoke: () => Promise<T>
  readonly onStartDenied?: () => void
}): Promise<T> {
  const { writer, stepId, taskId, provider, model } = input
  try { await writer.append("model.started", stepId, null, { taskId, provider, model }, `model-started:${stepId}`) }
  catch (error: unknown) { input.onStartDenied?.(); throw error }
  let output: T
  try { output = await input.invoke() }
  catch (error: unknown) {
    const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "model_execution_failed"
    await writer.append("model.failed", stepId, null, { taskId, provider, model, errorCode }, `model-failed:${stepId}`).catch(() => undefined)
    throw error
  }
  await writer.append("model.completed", stepId, null, { taskId, provider, model }, `model-completed:${stepId}`)
  return output
}
