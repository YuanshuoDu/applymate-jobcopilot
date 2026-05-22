"use client";

import { useState, useEffect, useRef } from "react";

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

const STATUS_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  submitted: { icon: "✅", label: "Submitted",        color: "#22c55e" },
  manual:    { icon: "⚠️", label: "Needs attention", color: "#f59e0b" },
  failed:    { icon: "❌", label: "Failed",            color: "#ef4444" },
  "dry-run": { icon: "🔍", label: "Dry run",          color: "#6b7280" },
};

export default function ApplyStatusCard({ jobId }: { jobId: string }) {
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
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
    try {
      await fetch(`/api/jobs/${jobId}/auto-apply`, { method: "POST" });
    } finally {
      setApplying(false);
    }
  }

  if (loading) return null;
  if (!result) return null;

  const cfg = STATUS_CONFIG[result.status] ?? { icon: "📋", label: result.status, color: "#6b7280" };
  const flowLabel = result.flowUsed === "programmatic" ? "Pre-programmed flow" : result.flowUsed === "llm" ? "AI agent" : result.flowUsed;
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
        <span style={{ fontWeight: 600, fontSize: 14, color: cfg.color }}>{cfg.label}</span>
      </div>

      <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 4 }}>
        {flowLabel && <span>{flowLabel}  ·  {durationSec}s</span>}
        {result.error && (
          <span style={{ color: "#ef4444" }}>
            {result.error.length > 120 ? result.error.slice(0, 120) + "…" : result.error}
          </span>
        )}
      </div>

      {result.status === "manual" && result.error && (
        <div style={{ marginTop: 8 }}>
          <a href={result.error} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#185FA5" }}>
            Apply manually ↗
          </a>
        </div>
      )}

      {result.status === "failed" && (
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
          {applying ? "Retrying…" : "🔄 Retry"}
        </button>
      )}
    </div>
  );
}
