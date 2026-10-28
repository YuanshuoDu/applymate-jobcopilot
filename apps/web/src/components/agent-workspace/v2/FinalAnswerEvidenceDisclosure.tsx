'use client'

import React from 'react'
import type { Lang } from '@/lib/i18n'
import { projectAnswerEvidence } from '@/lib/agent/session/final-answer-evidence-projection'

interface FinalAnswerEvidenceDisclosureProps {
  id: string
  evidence: unknown
  open: boolean
  selectedKey?: string | null
  onOpenChange: (open: boolean) => void
  lang?: Lang
}

/** Shows validated previews as inert text beside the model-attributed answer. */
export function FinalAnswerEvidenceDisclosure({ id, evidence: value, open, selectedKey, onOpenChange, lang = 'en' }: FinalAnswerEvidenceDisclosureProps) {
  const evidence = projectAnswerEvidence(value)
  if (!evidence) return null
  const copy = DISCLOSURE_COPY[lang]

  return (
    <details id={id} open={open} aria-label={copy.label} data-agent-answer-evidence="true"
      onToggle={event => onOpenChange(event.currentTarget.open)}
      style={{ border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px', color: 'var(--text)', fontSize: 12 }}>
      <summary style={{ cursor: 'pointer', color: 'var(--primary)', fontWeight: 600 }}>{copy.summary(evidence.sources.length)}</summary>
      <p style={{ margin: '9px 0 4px', color: 'var(--text-muted)', fontSize: 11 }}>{copy.context}</p>
      <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: 11 }}>{copy.disclaimer}</p>
      <div style={{ display: 'grid', gap: 8 }}>
        {evidence.sources.map(source => (
          <section key={source.key} id={`${id}-${source.key}`} data-agent-source-preview={source.key}
            data-selected={selectedKey === source.key ? 'true' : 'false'}
            style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 9px', background: selectedKey === source.key ? 'var(--bg-secondary)' : 'var(--bg)' }}>
            <h3 style={{ margin: '0 0 5px', fontSize: 12, fontWeight: 600 }}>{source.key} · {source.label}</h3>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.excerpt}</p>
          </section>
        ))}
      </div>
    </details>
  )
}

const DISCLOSURE_COPY: Record<Lang, { label: string; summary: (count: number) => string; context: string; disclaimer: string }> = {
  en: {
    label: 'Answer source previews', summary: count => `Source previews (${count})`, context: 'Agent context snapshot',
    disclaimer: 'Agent-linked source. This reference was selected by the model; its support for the claim has not been independently verified.',
  },
  de: {
    label: 'Quellvorschauen der Antwort', summary: count => `Quellvorschauen (${count})`, context: 'Agent-Kontext-Snapshot',
    disclaimer: 'Mit dem Agent verknüpfte Quelle. Diese Referenz wurde vom Modell ausgewählt; ihre Unterstützung der Aussage wurde nicht unabhängig überprüft.',
  },
  fr: {
    label: 'Aperçus des sources de la réponse', summary: count => `Aperçus des sources (${count})`, context: 'Instantané du contexte de l’agent',
    disclaimer: 'Source associée à l’agent. Cette référence a été sélectionnée par le modèle ; son appui à l’affirmation n’a pas été vérifié indépendamment.',
  },
  es: {
    label: 'Vistas previas de fuentes de la respuesta', summary: count => `Vistas previas de fuentes (${count})`, context: 'Instantánea del contexto del agente',
    disclaimer: 'Fuente vinculada al agente. El modelo seleccionó esta referencia; no se ha verificado de forma independiente que respalde la afirmación.',
  },
  nl: {
    label: 'Bronvoorbeelden bij het antwoord', summary: count => `Bronvoorbeelden (${count})`, context: 'Momentopname van de agentcontext',
    disclaimer: 'Aan de agent gekoppelde bron. Het model heeft deze verwijzing gekozen; de ondersteuning van de bewering is niet onafhankelijk gecontroleerd.',
  },
  zh: {
    label: '回答来源预览', summary: count => `来源预览（${count}）`, context: 'Agent 上下文快照',
    disclaimer: 'Agent 关联来源。此引用由模型选择；它对相关声明的支持尚未经过独立验证。',
  },
}
