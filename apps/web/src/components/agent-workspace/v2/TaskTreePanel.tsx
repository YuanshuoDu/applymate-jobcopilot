"use client"
import React, { useEffect, useRef, useState } from "react"
import { useI18n } from "@/lib/i18n"
import type { TimelineItem } from "./timeline-reducer"
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
  readonly statusVersion?: string | null
  readonly onAccepted: () => void
}

export function projectTaskInterruptView(eligible: boolean, status: TaskInterruptControlProps["status"], acceptedAtVersion: string | null | undefined, statusVersion: string | null, requestErrorVersion?: string | null) {
  const localAccepted = acceptedAtVersion !== undefined && acceptedAtVersion === statusVersion
  const visibleStatus = status === "interrupted" ? status : localAccepted ? "accepted" : status
  return { visibleStatus, showRetry: eligible && visibleStatus !== "accepted" && visibleStatus !== "interrupted", showRequestError: requestErrorVersion !== undefined && requestErrorVersion === statusVersion && status !== "accepted" && status !== "interrupted" }
}
export function taskInterruptEventVersion(items: readonly TimelineItem[], taskId: string): string | null {
  const events = items.filter(item => item.taskId === taskId && item.type === "unknown"
    && ["task.interrupt.accepted", "task.interrupt.failed"].includes(String((item.content as Record<string, unknown> | null)?.eventType)))
  const id = events.sort((a, b) => {
    if (a.sequence && b.sequence && /^\d+$/.test(a.sequence) && /^\d+$/.test(b.sequence)) return a.sequence.length - b.sequence.length || a.sequence.localeCompare(b.sequence)
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  }).at(-1)?.id
  return id?.replace(/^unknown:/, "") ?? null
}
export function taskInterruptKeyForVersion(current: { id: string; statusVersion: string | null } | null, statusVersion: string | null, createKey: () => string) {
  return current && current.statusVersion === statusVersion ? current : { id: createKey(), statusVersion }
}
type InterruptCopy = Readonly<{ action: string; title: (name: string) => string; scope: string; cancel: string; confirm: string; accepted: string; interrupted: string; failed: string; requestError: string }>
const INTERRUPT_COPY: Record<string, InterruptCopy> = {
  en: { action: "Interrupt task and descendants", title: name => `Interrupt ${name} and all descendants?`, scope: "This affects the selected task and its nested child tasks. Its parent and unrelated siblings continue; siblings that depend on it may be cancelled by dependency rules.", cancel: "Cancel", confirm: "Confirm interruption", accepted: "Interrupt request accepted. The task may take time to stop.", interrupted: "Task interrupted.", failed: "The interrupt request could not be applied.", requestError: "Could not confirm the interrupt request. Retry to check the same request." },
  de: { action: "Aufgabe und untergeordnete Aufgaben unterbrechen", title: name => `${name} und alle untergeordneten Aufgaben unterbrechen?`, scope: "Betroffen sind diese Aufgabe und ihre untergeordneten Aufgaben. Die übergeordnete Aufgabe und unabhängige Geschwister laufen weiter; abhängige Geschwister können nach den Abhängigkeitsregeln abgebrochen werden.", cancel: "Abbrechen", confirm: "Unterbrechung bestätigen", accepted: "Unterbrechung angefordert. Das Beenden kann etwas dauern.", interrupted: "Aufgabe unterbrochen.", failed: "Die Unterbrechung konnte nicht ausgeführt werden.", requestError: "Die Anfrage konnte nicht bestätigt werden. Wiederhole dieselbe Anfrage." },
  fr: { action: "Interrompre la tâche et ses descendants", title: name => `Interrompre ${name} et tous ses descendants ?`, scope: "Cette tâche et ses tâches enfants seront concernées. La tâche parente et les tâches sœurs sans dépendance continueront ; celles qui en dépendent peuvent être annulées selon les règles de dépendance.", cancel: "Annuler", confirm: "Confirmer l’interruption", accepted: "Demande d’interruption acceptée. L’arrêt peut prendre un instant.", interrupted: "Tâche interrompue.", failed: "La demande d’interruption n’a pas abouti.", requestError: "Impossible de confirmer la demande. Réessayez avec la même demande." },
  es: { action: "Interrumpir tarea y descendientes", title: name => `¿Interrumpir ${name} y todos sus descendientes?`, scope: "Afecta a esta tarea y a sus tareas secundarias. La tarea principal y las hermanas no dependientes continuarán; las que dependan de ella pueden cancelarse según las reglas de dependencia.", cancel: "Cancelar", confirm: "Confirmar interrupción", accepted: "Solicitud aceptada. La tarea puede tardar en detenerse.", interrupted: "Tarea interrumpida.", failed: "No se pudo aplicar la solicitud de interrupción.", requestError: "No se pudo confirmar la solicitud. Reintenta la misma solicitud." },
  nl: { action: "Taak en onderliggende taken onderbreken", title: name => `${name} en alle onderliggende taken onderbreken?`, scope: "Dit heeft invloed op deze taak en onderliggende taken. De bovenliggende taak en niet-afhankelijke zustertaken gaan door; zustertaken die ervan afhangen kunnen volgens de afhankelijkheidsregels worden geannuleerd.", cancel: "Annuleren", confirm: "Onderbreking bevestigen", accepted: "Onderbreking aangevraagd. Stoppen kan even duren.", interrupted: "Taak onderbroken.", failed: "Het onderbrekingsverzoek kon niet worden uitgevoerd.", requestError: "Het verzoek kon niet worden bevestigd. Probeer hetzelfde verzoek opnieuw." },
  zh: { action: "中断任务及其后代任务", title: name => `中断“${name}”及其所有后代任务？`, scope: "这会影响所选任务及其子任务。父任务和不依赖该任务的同级任务会继续；依赖该任务的同级任务可能按依赖规则取消。", cancel: "取消", confirm: "确认中断", accepted: "中断请求已接受。任务可能需要一些时间才能停止。", interrupted: "任务已中断。", failed: "无法执行中断请求。", requestError: "无法确认中断请求。请使用同一请求重试。" },
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
export function TaskInterruptControl({ sessionId, taskId, taskLabel, eligible, status, statusVersion = null, onAccepted }: TaskInterruptControlProps) {
  const { lang } = useI18n()
  const copy = INTERRUPT_COPY[lang] ?? INTERRUPT_COPY.en!
  const [confirming, setConfirming] = useState(false)
  const [acceptedAtVersion, setAcceptedAtVersion] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [requestErrorVersion, setRequestErrorVersion] = useState<string | null | undefined>(undefined)
  const key = useRef<{ id: string; statusVersion: string | null } | null>(null)
  const actionButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const statusMessage = useRef<HTMLParagraphElement>(null)
  const confirmationWasOpen = useRef(false)
  useEffect(() => { setConfirming(false); setAcceptedAtVersion(undefined); setRequestErrorVersion(undefined); key.current = null }, [sessionId, taskId])
  useEffect(() => { if (requestErrorVersion !== undefined && (requestErrorVersion !== statusVersion || status === "accepted" || status === "interrupted")) setRequestErrorVersion(undefined) }, [requestErrorVersion, status, statusVersion])
  useEffect(() => {
    if (!confirming) {
      if (confirmationWasOpen.current) {
        confirmationWasOpen.current = false
        restoreTaskInterruptFocus(actionButton.current, statusMessage.current)
      }
      return
    }
    confirmationWasOpen.current = true
    const dialogElement = dialog.current
    if (!dialogElement) return
    cancelButton.current?.focus()
    const handleKeydown = (event: KeyboardEvent) => handleTaskInterruptDialogKeydown(event, dialogElement, () => setConfirming(false))
    const handleFocusIn = (event: FocusEvent) => keepTaskInterruptDialogFocus(dialogElement, event.target, cancelButton.current)
    document.addEventListener("keydown", handleKeydown, true)
    document.addEventListener("focusin", handleFocusIn, true)
    return () => {
      document.removeEventListener("keydown", handleKeydown, true)
      document.removeEventListener("focusin", handleFocusIn, true)
    }
  }, [confirming])
  const interruptView = projectTaskInterruptView(eligible, status, acceptedAtVersion, statusVersion, requestErrorVersion)
  const visibleStatus = interruptView.visibleStatus
  const submit = async () => {
    if (!sessionId || !taskId || busy) return
    key.current = taskInterruptKeyForVersion(key.current, statusVersion, () => crypto.randomUUID())
    const clientMessageId = key.current.id
    setBusy(true)
    setRequestErrorVersion(undefined)
    try {
      const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/interrupt`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": clientMessageId },
        body: JSON.stringify({ clientMessageId }),
      })
      if (!response.ok) throw new Error("task_interrupt_rejected")
      setAcceptedAtVersion(statusVersion)
      setConfirming(false)
      onAccepted()
    } catch { setRequestErrorVersion(statusVersion) } finally { setBusy(false) }
  }
  if (!sessionId || (!eligible && !visibleStatus)) return null
  return <div style={{ display: "grid", justifyItems: "start", gap: 6, marginTop: 8 }}>
    {visibleStatus === "accepted" && <p ref={statusMessage} tabIndex={-1} role="status" aria-live="polite" style={interruptStatusStyle}>{copy.accepted}</p>}
    {visibleStatus === "interrupted" && <p ref={statusMessage} tabIndex={-1} role="status" style={interruptStatusStyle}>{copy.interrupted}</p>}
    {visibleStatus === "failed" && <p role="alert" style={{ ...interruptStatusStyle, color: "var(--c-danger)" }}>{copy.failed}</p>}
    {interruptView.showRequestError && <p role="alert" style={{ ...interruptStatusStyle, color: "var(--c-danger)" }}>{copy.requestError}</p>}
    {interruptView.showRetry && <button ref={actionButton} type="button" aria-haspopup="dialog" onClick={() => setConfirming(true)} style={actionStyle}>{copy.action}</button>}
    <section ref={dialog} hidden={!confirming} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="task-interrupt-title" aria-describedby="task-interrupt-scope" style={confirmationStyle}>
      <strong id="task-interrupt-title">{copy.title(taskLabel)}</strong><p id="task-interrupt-scope" style={interruptStatusStyle}>{copy.scope}</p>
      <div style={{ display: "flex", gap: 8 }}><button ref={cancelButton} type="button" onClick={() => setConfirming(false)} style={actionStyle}>{copy.cancel}</button>
        <button type="button" onClick={() => void submit()} disabled={busy} style={actionStyle}>{copy.confirm}</button></div>
    </section>
  </div>
}

export function handleTaskInterruptDialogKeydown(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  dialog: HTMLElement,
  dismiss: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault()
    dismiss()
    return
  }
  if (event.key !== "Tab") return
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  )).filter(element => !element.closest("[hidden],[inert]") && element.getAttribute("aria-hidden") !== "true")
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) {
    event.preventDefault()
    dialog.focus()
    return
  }
  const active = dialog.ownerDocument.activeElement
  if (!dialog.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  } else if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

export function keepTaskInterruptDialogFocus(dialog: HTMLElement, target: EventTarget | null, initialFocus: HTMLElement | null): void {
  if (!dialog.contains(target as Node | null)) initialFocus?.focus()
}
export function restoreTaskInterruptFocus(trigger: HTMLElement | null, fallback: HTMLElement | null): void {
  const target = trigger?.isConnected ? trigger : fallback?.isConnected ? fallback : null
  target?.focus()
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
