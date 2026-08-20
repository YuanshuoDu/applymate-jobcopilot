"use client";

import { useState, useEffect, useRef } from "react";
import { useI18n } from '@/lib/i18n'

interface ApplyResult {
  id: number;
  status: string;
  mode: string;
  atsType: string | null;
  flowUsed: string | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
}

const STATUS_CONFIG: Record<string, { icon: string; labelKey: string; color: string }> = {
  submitted: { icon: "✅", labelKey: "jobs.applyStatus.submitted",        color: "#22c55e" },
  manual:    { icon: "⚠️", labelKey: "jobs.applyStatus.needsAttention", color: "#f59e0b" },
  failed:    { icon: "❌", labelKey: "jobs.applyStatus.failed",            color: "#ef4444" },
  "dry-run": { icon: "🔍", labelKey: "jobs.applyStatus.dryRun",          color: "#6b7280" },
};

export default function ApplyStatusCard({ jobId, jobUrl, jobStatus }: { jobId: string; jobUrl?: string; jobStatus?: string }) {
  const { lang, t } = useI18n()
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchResult() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/apply-results`);
      if (!res.ok) return;
      const data = await res.json();
      const results: ApplyResult[] = data.results ?? [];
      if (results.length > 0) {
        setResult(results[0]);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }
    } catch {
      // network error, retry on next poll
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchResult();
    // Auto-poll every 5s while no result yet
    pollRef.current = setInterval(() => {
      if (!result) fetchResult();
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId]);

  async function handleRetry() {
    setApplying(true);
    setRetryError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/auto-apply`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not queue the application.");
      setResult(null);
      void fetchResult();
    } catch (error) {
      setRetryError(lang === 'zh' ? t('common.somethingWentWrong') : error instanceof Error ? error.message : t('jobs.applyStatus.queueFailed'));
    } finally {
      setApplying(false);
    }
  }

  if (loading) return null;
  if (!result) {
    // Show spinner while task is in-flight (job.status = 'applied' but no result written yet)
    if (jobStatus === 'applied') {
      return (
        <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid #185FA5', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('jobs.applyingBackground')}</span>
        </div>
      )
    }
    return null
  }

  const cfg = STATUS_CONFIG[result.status] ?? { icon: "📋", labelKey: "jobs.applyStatus.unknown", color: "#6b7280" };
  const flowLabel = result.flowUsed === "pattern-cache" ? t('jobs.applyStatus.patternReplay') : result.flowUsed === "programmatic" ? t('jobs.applyStatus.programmedFlow') : result.flowUsed === "llm" ? t('jobs.applyStatus.aiAgent') : result.flowUsed;
  const durationSec = Math.round(result.durationMs / 1000);

  return (
    <div style={{
      background: "var(--bg-secondary)",
      borderRadius: 8,
      padding: "12px 16px",
      marginTop: 12,
      border: `1px solid ${cfg.color}40`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 18 }}>{cfg.icon}</span>
        <span style={{ fontWeight: 600, fontSize: 14, color: cfg.color }}>{t(cfg.labelKey)}</span>
      </div>

      <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 4 }}>
        {flowLabel && <span>{flowLabel}  ·  {durationSec}s</span>}
        {result.error && (
          <span style={{ color: "#ef4444" }}>
            {lang === 'zh' ? t('common.somethingWentWrong') : result.error.length > 120 ? result.error.slice(0, 120) + "…" : result.error}
          </span>
        )}
      </div>

      {result.status === "manual" && result.error && (
        <div style={{ marginTop: 8 }}>
          <a href={jobUrl ?? '#'} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#185FA5" }}>
            {t('jobs.applyStatus.applyManually')} ↗
          </a>
        </div>
      )}

      {result.status === "failed" && (
        <>
          <button
            onClick={handleRetry}
            disabled={applying}
            style={{
              marginTop: 8,
              padding: "6px 16px",
              fontSize: 13,
              background: "#ef4444",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: applying ? "not-allowed" : "pointer",
              opacity: applying ? 0.6 : 1,
            }}
          >
            {applying ? t('jobs.applyStatus.queueing') : `🔄 ${t('jobs.applyStatus.queueRetry')}`}
          </button>
          {retryError && <div style={{ marginTop: 6, fontSize: 12, color: "#ef4444" }}>{lang === 'zh' ? t('common.somethingWentWrong') : retryError}</div>}
        </>
      )}
    </div>
  );
}
