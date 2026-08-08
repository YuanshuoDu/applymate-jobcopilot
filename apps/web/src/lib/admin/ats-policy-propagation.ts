export type AtsPolicyPropagationCommand = {
  requestId: string
  actorId: string
  sourceKey: string
  version: number
  reason: string
}

type WorkerAcknowledgement = { acknowledgedVersion?: unknown }

type PropagationDependencies = {
  send: (command: {
    requestId: string
    actorId: string
    action: 'apply_ats_policy'
    reason: string
    params: { sourceKey: string; version: number }
  }) => Promise<WorkerAcknowledgement>
  markAcknowledged: (sourceKey: string, version: number) => Promise<number>
}

export async function acknowledgeCommittedAtsPolicy(
  command: AtsPolicyPropagationCommand,
  dependencies: PropagationDependencies,
): Promise<'acknowledged' | 'pending'> {
  try {
    const result = await dependencies.send({
      requestId: command.requestId,
      actorId: command.actorId,
      action: 'apply_ats_policy',
      reason: command.reason,
      params: { sourceKey: command.sourceKey, version: command.version },
    })
    if (result.acknowledgedVersion !== command.version) return 'pending'
    return await dependencies.markAcknowledged(command.sourceKey, command.version) === 1
      ? 'acknowledged'
      : 'pending'
  } catch {
    return 'pending'
  }
}
