'use client'

import React from 'react'
import { useI18n, type Lang } from '@/lib/i18n'
import type { ActiveTurnStatus, ScheduledPipelineRecoveryReason } from './agent-session-state'

type NoticePhase = 'waiting' | 'stopped'

const copy: Record<Lang, Record<NoticePhase, string>> = {
  en: {
    waiting: 'This scheduled run cannot continue because its source material changed. Stop this run, then use Run Now to start a new manual run. It will use this automation’s current settings.',
    stopped: 'This scheduled run stopped because its source material changed. Use Run Now to start a new manual run. It will use this automation’s current settings.',
  },
  de: {
    waiting: 'Dieser geplante Lauf kann nicht fortgesetzt werden, weil sich die Quelldaten geändert haben. Stoppen Sie den Lauf und wählen Sie dann „Jetzt ausführen“, um einen neuen manuellen Lauf mit den aktuellen Einstellungen dieser Automation zu starten.',
    stopped: 'Dieser geplante Lauf wurde gestoppt, weil sich die Quelldaten geändert haben. Wählen Sie „Jetzt ausführen“, um einen neuen manuellen Lauf mit den aktuellen Einstellungen dieser Automation zu starten.',
  },
  fr: {
    waiting: 'Cette exécution planifiée ne peut pas continuer, car les données source ont changé. Arrêtez-la, puis choisissez « Exécuter maintenant » pour lancer une nouvelle exécution manuelle avec les paramètres actuels de cette automation.',
    stopped: 'Cette exécution planifiée a été arrêtée, car les données source ont changé. Choisissez « Exécuter maintenant » pour lancer une nouvelle exécution manuelle avec les paramètres actuels de cette automation.',
  },
  es: {
    waiting: 'Esta ejecución programada no puede continuar porque cambiaron los datos de origen. Deténla y después selecciona «Ejecutar ahora» para iniciar una nueva ejecución manual con la configuración actual de esta automatización.',
    stopped: 'Esta ejecución programada se detuvo porque cambiaron los datos de origen. Selecciona «Ejecutar ahora» para iniciar una nueva ejecución manual con la configuración actual de esta automatización.',
  },
  nl: {
    waiting: 'Deze geplande uitvoering kan niet doorgaan omdat het bronmateriaal is gewijzigd. Stop deze uitvoering en kies daarna ‘Nu uitvoeren’ om een nieuwe handmatige uitvoering met de huidige instellingen van deze automatisering te starten.',
    stopped: 'Deze geplande uitvoering is gestopt omdat het bronmateriaal is gewijzigd. Kies ‘Nu uitvoeren’ om een nieuwe handmatige uitvoering met de huidige instellingen van deze automatisering te starten.',
  },
  zh: {
    waiting: '此计划运行因来源材料发生变化而无法继续。请先停止当前运行，再选择“立即运行”启动新的手动运行；新运行会沿用此自动化当前的设置。',
    stopped: '此计划运行因来源材料发生变化而已停止。请选择“立即运行”启动新的手动运行；新运行会沿用此自动化当前的设置。',
  },
}

export function ScheduledSourceChangeRecoveryNotice({
  reason,
  turnStatus,
}: {
  reason: ScheduledPipelineRecoveryReason | null
  turnStatus: ActiveTurnStatus | undefined
}) {
  const { lang } = useI18n()
  if (reason !== 'scheduled_pipeline_source_changed') return null

  const phase: NoticePhase = turnStatus === 'waiting_for_dependency' ? 'waiting' : 'stopped'
  return (
    <aside role="status" aria-live="polite" aria-atomic="true" data-testid="source-change-recovery-notice"
      style={{ margin: '6px 10px 0', padding: '9px 12px', borderRadius: 8, background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.24)', color: 'var(--text)', fontSize: 12 }}>
      {copy[lang][phase]}
    </aside>
  )
}
