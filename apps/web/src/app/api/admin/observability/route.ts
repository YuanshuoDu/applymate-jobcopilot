import { NextRequest } from "next/server";
import { ok } from "@/lib/api-helpers";
import { db } from "@/lib/db";

type OverallRow = {
  total: number | null;
  successRate: number | null;
  programmatic: number | null;
  patternCache: number | null;
  llm: number | null;
  avgDurationMs: number | null;
  captchaErrors: number | null;
  last24h: number | null;
  last24hSuccessRate: number | null;
};

type AtsRow = {
  atsType: string | null;
  count: number;
  successRate: number | null;
};

export async function GET(_req: NextRequest) {
  const overallRows = await db.$queryRaw`
    SELECT
      COUNT(*)::int AS total,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'submitted') / NULLIF(COUNT(*), 0), 1)::float, 0) AS "successRate",
      COUNT(*) FILTER (WHERE flow_used = 'programmatic')::int AS programmatic,
      COUNT(*) FILTER (WHERE flow_used = 'pattern-cache')::int AS "patternCache",
      COUNT(*) FILTER (WHERE flow_used = 'llm')::int AS llm,
      COALESCE(ROUND(AVG(duration_ms))::int, 0) AS "avgDurationMs",
      COUNT(*) FILTER (WHERE error ILIKE '%captcha%')::int AS "captchaErrors",
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS "last24h",
      COALESCE(
        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE status = 'submitted' AND created_at > NOW() - INTERVAL '24 hours'
          ) / NULLIF(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0),
          1
        )::float,
        0
      ) AS "last24hSuccessRate"
    FROM apply_results
  ` as OverallRow[];

  const byAtsRows = await db.$queryRaw`
    SELECT
      COALESCE(ats_type, 'unknown') AS "atsType",
      COUNT(*)::int AS count,
      COALESCE(
        ROUND(100.0 * COUNT(*) FILTER (WHERE status='submitted') / NULLIF(COUNT(*),0), 1)::float,
        0
      ) AS "successRate"
    FROM apply_results
    GROUP BY ats_type
    ORDER BY count DESC
  ` as AtsRow[];

  const row = overallRows[0] ?? {
    total: 0,
    successRate: 0,
    programmatic: 0,
    patternCache: 0,
    llm: 0,
    avgDurationMs: 0,
    captchaErrors: 0,
    last24h: 0,
    last24hSuccessRate: 0,
  };
  const total = Number(row.total ?? 0);
  const programmatic = Number(row.programmatic ?? 0);
  const patternCache = Number(row.patternCache ?? 0);
  const llm = Number(row.llm ?? 0);
  const captchaErrors = Number(row.captchaErrors ?? 0);

  return ok({
    overall: {
      total,
      successRate: Number(row.successRate ?? 0),
      byFlowUsed: {
        programmatic,
        patternCache,
        llm,
        unknown: Math.max(total - programmatic - patternCache - llm, 0),
      },
      avgDurationMs: Number(row.avgDurationMs ?? 0),
      captchaRate: total > 0 ? Number(((captchaErrors / total) * 100).toFixed(1)) : 0,
      captchaErrors,
      last24h: {
        count: Number(row.last24h ?? 0),
        successRate: Number(row.last24hSuccessRate ?? 0),
      },
    },
    byAts: byAtsRows.map((ats) => ({
      atsType: ats.atsType ?? "unknown",
      count: Number(ats.count ?? 0),
      successRate: Number(ats.successRate ?? 0),
    })),
  });
}
