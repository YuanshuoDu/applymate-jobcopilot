export type ApplicationTaskRow = { status: string }

export function applicationTaskSummary(tasks: ApplicationTaskRow[]) {
  return tasks.reduce((summary, task) => {
    if (task.status === "submitted") summary.submitted++
    else if (task.status === "skipped") summary.skipped++
    else if (task.status === "failed") summary.failed++
    else if (task.status === "waiting_for_user" || task.status === "waiting_for_authorization") summary.needsUser++
    else summary.inProgress++
    return summary
  }, { submitted: 0, skipped: 0, failed: 0, needsUser: 0, inProgress: 0 })
}

export function mayCancelApplicationTask(status: string): boolean {
  return !["submitted", "skipped", "cancelled"].includes(status)
}
