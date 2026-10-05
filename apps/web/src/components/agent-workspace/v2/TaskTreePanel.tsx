"use client"

import React, { useEffect, useRef, useState } from "react"

import { useI18n } from "@/lib/i18n"

import type { TaskTreeNode } from "./types"

export interface TaskTreePanelProps {
  readonly nodes: readonly TaskTreeNode[]
  readonly selectedId?: string
  readonly sessionKey?: string
  readonly showHeading?: boolean
  readonly onSelect: (id: string) => void
}

export interface TaskInterruptControlProps {
  readonly sessionId: string | null
  readonly taskId: string
  readonly taskLabel: string
  readonly eligible: boolean
  readonly status: "accepted" | "interrupted" | "failed" | null
  readonly onAccepted: () => void
}

type InterruptCopy = Readonly<{ action: string; title: (name: string) => string; scope: string; cancel: string; confirm: string; accepted: string; interrupted: string; failed: string; requestError: string }>
const INTERRUPT_COPY: Record<string, InterruptCopy> = {
  en: { action: "Interrupt task and descendants", title: name => `Interrupt ${name} and all descendants?`, scope: "This affects the selected task and its nested child tasks. Its parent and sibling tasks will continue.", cancel: "Cancel", confirm: "Confirm interruption", accepted: "Interrupt request accepted. The task may take time to stop.", interrupted: "Task interrupted.", failed: "The interrupt request could not be applied.", requestError: "Could not confirm the interrupt request. Retry to check the same request." },
  de: { action: "Aufgabe und untergeordnete Aufgaben unterbrechen", title: name => `${name} und alle untergeordneten Aufgaben unterbrechen?`, scope: "Betroffen sind diese Aufgabe und ihre untergeordneten Aufgaben. Übergeordnete und benachbarte Aufgaben laufen weiter.", cancel: "Abbrechen", confirm: "Unterbrechung bestätigen", accepted: "Unterbrechung angefordert. Das Beenden kann etwas dauern.", interrupted: "Aufgabe unterbrochen.", failed: "Die Unterbrechung konnte nicht ausgeführt werden.", requestError: "Die Anfrage konnte nicht bestätigt werden. Wiederhole dieselbe Anfrage." },
  fr: { action: "Interrompre la tâche et ses descendants", title: name => `Interrompre ${name} et tous ses descendants ?`, scope: "Cette tâche et ses tâches enfants seront concernées. Le parent et les tâches sœurs continueront.", cancel: "Annuler", confirm: "Confirmer l’interruption", accepted: "Demande d’interruption acceptée. L’arrêt peut prendre un instant.", interrupted: "Tâche interrompue.", failed: "La demande d’interruption n’a pas abouti.", requestError: "Impossible de confirmer la demande. Réessayez avec la même demande." },
  es: { action: "Interrumpir tarea y descendientes", title: name => `¿Interrumpir ${name} y todos sus descendientes?`, scope: "Afecta a esta tarea y sus tareas secundarias. La tarea principal y las hermanas continuarán.", cancel: "Cancelar", confirm: "Confirmar interrupción", accepted: "Solicitud aceptada. La tarea puede tardar en detenerse.", interrupted: "Tarea interrumpida.", failed: "No se pudo aplicar la solicitud de interrupción.", requestError: "No se pudo confirmar la solicitud. Reintenta la misma solicitud." },
  nl: { action: "Taak en onderliggende taken onderbreken", title: name => `${name} en alle onderliggende taken onderbreken?`, scope: "Deze taak en de onderliggende taken worden onderbroken. De bovenliggende en zuster taken gaan door.", cancel: "Annuleren", confirm: "Onderbreking bevestigen", accepted: "Onderbreking aangevraagd. Stoppen kan even duren.", interrupted: "Taak onderbroken.", failed: "Het onderbrekingsverzoek kon niet worden uitgevoerd.", requestError: "Het verzoek kon niet worden bevestigd. Probeer hetzelfde verzoek opnieuw." },
  zh: { action: "中断任务及其后代任务", title: name => `中断“${name}”及其所有后代任务？`, scope: "这会影响所选任务及其子任务。父任务和同级任务会继续运行。", cancel: "取消", confirm: "确认中断", accepted: "中断请求已接受。任务可能需要一些时间才能停止。", interrupted: "任务已中断。", failed: "无法执行中断请求。", requestError: "无法确认中断请求。请使用同一请求重试。" },
}

/** Displays the bounded Turn → Step → Tool hierarchy without executing nodes. */
export function TaskTreePanel({ nodes, selectedId, sessionKey, showHeading = true, onSelect }: TaskTreePanelProps) {
  const { t } = useI18n()
  const [localSelectedId, setLocalSelectedId] = useState<string | undefined>(selectedId)

  useEffect(() => {
    setLocalSelectedId(undefined)
  }, [sessionKey])

  const activeSelectedId = sessionKey === undefined ? selectedId : localSelectedId
  const select = (node: TaskTreeNode) => {
    setLocalSelectedId(node.id)
    onSelect(node.id)
    if (node.itemId) scrollToTimelineItem(node.itemId)
  }

  return (
    <section aria-label={t('agent.tasks')} data-agent-task-tree="true" style={panelStyle}>
      {showHeading && <h2 style={headingStyle}>{t('agent.tasks')}</h2>}
      <div style={{ display: "grid", gap: 4 }}>{renderNodes(nodes, 0, activeSelectedId, select, t)}</div>
    </section>
  )
}

export function flattenTaskTree(nodes: readonly TaskTreeNode[], maxDepth = 5): TaskTreeNode[] {
  const result: TaskTreeNode[] = []
  const visit = (entries: readonly TaskTreeNode[], depth: number) => {
    if (depth >= maxDepth) return
    for (const node of entries) {
      result.push(node)
      visit(node.children ?? [], depth + 1)
    }
  }
  visit(nodes, 0)
  return result
}

/** A selected-child command whose visible state comes from durable events or the accepted response. */
export function TaskInterruptControl({ sessionId, taskId, taskLabel, eligible, status, onAccepted }: TaskInterruptControlProps) {
  const { lang } = useI18n()
  const copy = INTERRUPT_COPY[lang] ?? INTERRUPT_COPY.en!
  const [confirming, setConfirming] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [requestError, setRequestError] = useState(false)
  const key = useRef<string | null>(null)
  const actionButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { setConfirming(false); setAccepted(false); setRequestError(false); key.current = null }, [sessionId, taskId])
  useEffect(() => { if (status === "failed") { setAccepted(false); key.current = null } }, [status])
  useEffect(() => { if (confirming) cancelButton.current?.focus() }, [confirming])
  const visibleStatus = status ?? (accepted ? "accepted" : null)
  const submit = async () => {
    if (!sessionId || !taskId || busy) return
    if (visibleStatus === "failed") key.current = null
    key.current ??= crypto.randomUUID()
    setBusy(true)
    setRequestError(false)
    try {
      const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/interrupt`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": key.current },
        body: JSON.stringify({ clientMessageId: key.current }),
      })
      if (!response.ok) throw new Error("task_interrupt_rejected")
      setAccepted(true)
      setConfirming(false)
      onAccepted()
    } catch { setRequestError(true) } finally { setBusy(false) }
  }
  if (!sessionId || (!eligible && !visibleStatus)) return null
  return <div style={{ display: "grid", justifyItems: "start", gap: 6, marginTop: 8 }}>
    {visibleStatus === "accepted" && <p role="status" aria-live="polite" style={interruptStatusStyle}>{copy.accepted}</p>}
    {visibleStatus === "interrupted" && <p role="status" style={interruptStatusStyle}>{copy.interrupted}</p>}
    {visibleStatus === "failed" && <p role="alert" style={{ ...interruptStatusStyle, color: "var(--c-danger)" }}>{copy.failed}</p>}
    {requestError && <p role="alert" style={{ ...interruptStatusStyle, color: "var(--c-danger)" }}>{copy.requestError}</p>}
    {eligible && visibleStatus !== "accepted" && visibleStatus !== "interrupted" && <button ref={actionButton} type="button" aria-haspopup="dialog" onClick={() => setConfirming(true)} style={actionStyle}>{copy.action}</button>}
    <section hidden={!confirming} role="alertdialog" aria-modal="true" aria-labelledby="task-interrupt-title" aria-describedby="task-interrupt-scope" style={confirmationStyle}>
      <strong id="task-interrupt-title">{copy.title(taskLabel)}</strong><p id="task-interrupt-scope" style={interruptStatusStyle}>{copy.scope}</p>
      <div style={{ display: "flex", gap: 8 }}><button ref={cancelButton} type="button" onClick={() => { setConfirming(false); actionButton.current?.focus() }} style={actionStyle}>{copy.cancel}</button>
        <button type="button" onClick={() => void submit()} disabled={busy} style={actionStyle}>{copy.confirm}</button></div>
    </section>
  </div>
}

function renderNodes(nodes: readonly TaskTreeNode[], depth: number, selectedId: string | undefined, onSelect: (node: TaskTreeNode) => void, t: (key: string) => string): React.ReactNode {
  if (depth >= 5) return null
  return nodes.map(node => (
    <React.Fragment key={node.id}>
      <button
        type="button"
        data-task-node-id={node.id}
        data-task-tree-depth={depth}
        aria-current={selectedId === node.id ? "true" : undefined}
        onClick={() => onSelect(node)}
        style={{ ...nodeStyle, marginLeft: depth * 16, background: selectedId === node.id ? "var(--bg-secondary)" : "transparent" }}
      >
        <span style={{ color: "var(--primary)", fontSize: 11, fontWeight: 700 }}>{kindLabel(node.kind, t)}</span>
        <span style={{ flex: 1, textAlign: "left" }}>{node.label}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{statusLabel(node.status, t)}</span>
      </button>
      {node.resultAvailable && <span style={{ marginLeft: depth * 16 + 8, color: "var(--text-muted)", fontSize: 10 }}>{t('agent.toolResult')}</span>}
      {node.detail && <span style={{ marginLeft: depth * 16 + 8, color: "var(--c-danger)", fontSize: 10, overflowWrap: "anywhere" }}>{node.detail}</span>}
      {renderNodes(node.children ?? [], depth + 1, selectedId, onSelect, t)}
    </React.Fragment>
  ))
}

export function scrollToTimelineItem(itemId: string): void {
  if (typeof document === "undefined") return
  const element = Array.from(document.querySelectorAll<HTMLElement>("[data-agent-harness-item]"))
    .find(candidate => candidate.dataset.agentHarnessItem === itemId)
  element?.scrollIntoView({ behavior: "smooth", block: "center" })
}

const panelStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 10, padding: 14, background: "var(--bg)" }
const headingStyle: React.CSSProperties = { margin: 0, fontSize: 13, color: "var(--text)" }
const nodeStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, border: 0, borderRadius: 6, padding: "7px 8px", color: "var(--text)", cursor: "pointer", font: "inherit" }
const actionStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--bg)", color: "var(--primary)", cursor: "pointer", font: "inherit", fontSize: 11 }
const confirmationStyle: React.CSSProperties = { display: "grid", gap: 8, padding: 10, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-secondary)" }
const interruptStatusStyle: React.CSSProperties = { margin: 0, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }

function kindLabel(kind: TaskTreeNode["kind"], t: (key: string) => string): string {
  if (kind === "turn") return t("agent.turn")
  if (kind === "step") return t("agent.step")
  if (kind === "tool") return t("agent.toolActor")
  return t("agent.tasks")
}

function statusLabel(status: string, t: (key: string) => string): string {
  if (status === "queued" || status === "retrying") return t("agent.queuedTasks")
  if (status === "running" || status === "in_progress" || status === "started" || status === "streaming") return t("agent.running")
  if (status.startsWith("waiting")) return t("agent.waiting")
  if (status === "completed" || status === "passed") return t("agent.done")
  if (status === "failed" || status === "error") return t("agent.errorTitle")
  if (status === "interrupted" || status === "cancelled") return t("agent.toolCancelled")
  if (status === "paused") return t("agent.paused")
  return t("agent.unknownItem")
}
