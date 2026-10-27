import type { Lang } from '@/lib/i18n'

export type AgentWaitCopy = Readonly<{
  heading: string
  mode: string
  anyMode: string
  allMode: string
  status: string
  deadline: string
  taskDeadline: string
  taskDeadlineUnrecorded: string
  children: string
  matched: string
  notMatched: string
  selectTarget: (label: string) => string
  selected: string
  empty: string
  loading: string
  unavailable: string
  error: string
  waitDue: string
  taskDue: string
  child: string
  statuses: Readonly<Record<string, string>>
}>

const COPY: Record<Lang, AgentWaitCopy> = {
  en: {
    heading: 'Current child wait', mode: 'Mode', anyMode: 'Any child', allMode: 'All children', status: 'Status',
    deadline: 'Wait deadline', taskDeadline: 'Task deadline', taskDeadlineUnrecorded: 'No task deadline recorded', children: 'Children being awaited', matched: 'Matched', notMatched: 'Not matched',
    selectTarget: label => `Select ${label}`, selected: 'Selected', empty: 'No current child wait.', loading: 'Checking child wait…',
    unavailable: 'Wait details are unavailable.', error: 'Could not load wait details.', waitDue: 'Wait deadline reached', taskDue: 'Task deadline reached', child: 'Child',
    statuses: { queued: 'Queued', running: 'Running', retrying: 'Retrying', waiting: 'Waiting', waiting_for_user: 'Waiting for user', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', closed: 'Closed', passed: 'Passed', skipped: 'Skipped', unknown: 'Unknown' },
  },
  de: {
    heading: 'Aktuelles Warten auf untergeordnete Aufgaben', mode: 'Modus', anyMode: 'Beliebige untergeordnete Aufgabe', allMode: 'Alle untergeordneten Aufgaben', status: 'Status',
    deadline: 'Frist für das Warten', taskDeadline: 'Aufgabenfrist', taskDeadlineUnrecorded: 'Keine Aufgabenfrist erfasst', children: 'Erwartete untergeordnete Aufgaben', matched: 'Erfüllt', notMatched: 'Nicht erfüllt',
    selectTarget: label => `${label} auswählen`, selected: 'Ausgewählt', empty: 'Aktuell wird auf keine untergeordneten Aufgaben gewartet.', loading: 'Warten auf untergeordnete Aufgaben wird geprüft…',
    unavailable: 'Details zum Warten sind nicht verfügbar.', error: 'Details zum Warten konnten nicht geladen werden.', waitDue: 'Frist für das Warten erreicht', taskDue: 'Aufgabenfrist erreicht', child: 'Untergeordnete Aufgabe',
    statuses: { queued: 'In Warteschlange', running: 'Läuft', retrying: 'Wird erneut versucht', waiting: 'Wartet', waiting_for_user: 'Wartet auf den Benutzer', completed: 'Abgeschlossen', failed: 'Fehlgeschlagen', interrupted: 'Unterbrochen', cancelled: 'Abgebrochen', closed: 'Geschlossen', passed: 'Bestanden', skipped: 'Übersprungen', unknown: 'Unbekannt' },
  },
  fr: {
    heading: 'Attente actuelle des tâches enfants', mode: 'Mode', anyMode: 'Une tâche enfant', allMode: 'Toutes les tâches enfants', status: 'Statut',
    deadline: 'Échéance d’attente', taskDeadline: 'Échéance de la tâche', taskDeadlineUnrecorded: 'Aucune échéance de tâche enregistrée', children: 'Tâches enfants attendues', matched: 'Correspondance établie', notMatched: 'Pas encore de correspondance',
    selectTarget: label => `Sélectionner ${label}`, selected: 'Sélectionnée', empty: 'Aucune attente de tâche enfant en cours.', loading: 'Vérification de l’attente…',
    unavailable: 'Les détails de l’attente sont indisponibles.', error: 'Impossible de charger les détails de l’attente.', waitDue: 'Échéance d’attente atteinte', taskDue: 'Échéance de la tâche atteinte', child: 'Tâche enfant',
    statuses: { queued: 'En file', running: 'En cours', retrying: 'Nouvelle tentative', waiting: 'En attente', waiting_for_user: 'En attente de l’utilisateur', completed: 'Terminée', failed: 'Échec', interrupted: 'Interrompue', cancelled: 'Annulée', closed: 'Fermée', passed: 'Réussie', skipped: 'Ignorée', unknown: 'Inconnue' },
  },
  es: {
    heading: 'Espera actual de tareas secundarias', mode: 'Modo', anyMode: 'Cualquier tarea secundaria', allMode: 'Todas las tareas secundarias', status: 'Estado',
    deadline: 'Límite de espera', taskDeadline: 'Límite de la tarea', taskDeadlineUnrecorded: 'No se registró el límite de la tarea', children: 'Tareas secundarias esperadas', matched: 'Coincide', notMatched: 'Aún no coincide',
    selectTarget: label => `Seleccionar ${label}`, selected: 'Seleccionada', empty: 'No hay ninguna espera de tareas secundaria activa.', loading: 'Comprobando la espera…',
    unavailable: 'Los detalles de la espera no están disponibles.', error: 'No se pudieron cargar los detalles de la espera.', waitDue: 'Límite de espera alcanzado', taskDue: 'Límite de la tarea alcanzado', child: 'Tarea secundaria',
    statuses: { queued: 'En cola', running: 'En curso', retrying: 'Reintentando', waiting: 'En espera', waiting_for_user: 'Esperando al usuario', completed: 'Completada', failed: 'Fallida', interrupted: 'Interrumpida', cancelled: 'Cancelada', closed: 'Cerrada', passed: 'Superada', skipped: 'Omitida', unknown: 'Desconocida' },
  },
  nl: {
    heading: 'Huidig wachten op onderliggende taken', mode: 'Modus', anyMode: 'Een onderliggende taak', allMode: 'Alle onderliggende taken', status: 'Status',
    deadline: 'Wachtdeadline', taskDeadline: 'Taakdeadline', taskDeadlineUnrecorded: 'Geen taakdeadline vastgelegd', children: 'Taken waarop wordt gewacht', matched: 'Voldoet', notMatched: 'Voldoet nog niet',
    selectTarget: label => `${label} selecteren`, selected: 'Geselecteerd', empty: 'Er wordt momenteel niet op onderliggende taken gewacht.', loading: 'Wachten op onderliggende taken controleren…',
    unavailable: 'Wachtgegevens zijn niet beschikbaar.', error: 'Wachtgegevens konden niet worden geladen.', waitDue: 'Wachtdeadline bereikt', taskDue: 'Taakdeadline bereikt', child: 'Onderliggende taak',
    statuses: { queued: 'In wachtrij', running: 'Bezig', retrying: 'Opnieuw proberen', waiting: 'Wachtend', waiting_for_user: 'Wacht op gebruiker', completed: 'Voltooid', failed: 'Mislukt', interrupted: 'Onderbroken', cancelled: 'Geannuleerd', closed: 'Gesloten', passed: 'Geslaagd', skipped: 'Overgeslagen', unknown: 'Onbekend' },
  },
  zh: {
    heading: '当前子任务等待', mode: '模式', anyMode: '任一子任务', allMode: '所有子任务', status: '状态',
    deadline: '等待截止时间', taskDeadline: '任务总截止时间', taskDeadlineUnrecorded: '未记录任务总截止时间', children: '等待中的子任务', matched: '已匹配', notMatched: '尚未匹配',
    selectTarget: label => `选择${label}`, selected: '已选中', empty: '当前没有等待中的子任务。', loading: '正在检查子任务等待状态…',
    unavailable: '等待详情不可用。', error: '无法加载等待详情。', waitDue: '等待截止时间已到', taskDue: '任务总截止时间已到', child: '子任务',
    statuses: { queued: '排队中', running: '运行中', retrying: '重试中', waiting: '等待中', waiting_for_user: '等待用户', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', closed: '已关闭', passed: '已通过', skipped: '已跳过', unknown: '未知' },
  },
}

export function agentWaitCopy(lang: string): AgentWaitCopy {
  return COPY[isLang(lang) ? lang : 'en']
}

function isLang(value: string): value is Lang {
  return value === 'en' || value === 'de' || value === 'fr' || value === 'es' || value === 'nl' || value === 'zh'
}
