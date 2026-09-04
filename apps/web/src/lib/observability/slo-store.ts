import { db } from "@/lib/db"

import type { SloEvaluation } from "./slo-rules"

type AlertDelegate = {
  createMany(args: { data: Array<Record<string, unknown>> }): Promise<unknown>
}

export type SloAlertPersistenceClient = {
  harnessSloAlert: AlertDelegate
}

const defaultClient = db as unknown as SloAlertPersistenceClient

/** Persists one traceable result per SLO rule while keeping pass rows closed. */
export async function persistSloEvaluation(
  evaluation: SloEvaluation,
  client: SloAlertPersistenceClient = defaultClient,
): Promise<void> {
  await client.harnessSloAlert.createMany({
    data: evaluation.alerts.map((alert) => ({
      id: alert.alertId,
      ruleKey: alert.ruleId,
      metric: alert.ruleId,
      value: alert.observedValue,
      threshold: alert.threshold,
      traceId: alert.traceId,
      status: alert.status === "breach" ? "open" : "pass",
    })),
  })
}
