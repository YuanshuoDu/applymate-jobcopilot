import type { ApplicationTaskView } from './application-task-model'

/** Only this terminal checkpoint proves that submission had not started. */
export function applicationTaskAllowsManualWork(task: ApplicationTaskView | undefined): boolean {
  return !task || ((task.status === 'cancelled' || task.status === 'failed') && task.checkpoint === 'turn_stopped_before_submit')
}
