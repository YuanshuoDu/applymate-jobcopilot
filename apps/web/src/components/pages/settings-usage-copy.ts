import type { Lang } from '@/lib/i18n'

const en = {
  title: 'Usage & activity', subtitle: 'Your recorded AI usage across ApplyMate.', period: 'Time range',
  week: 'Last 7 days', month: 'Last 30 days', requests: 'AI requests', input: 'Input tokens', output: 'Output tokens',
  daily: 'Daily requests', models: 'Usage by model', model: 'Model', tokens: 'Total tokens', date: 'Date',
  activity: 'Recent activity', activityHint: 'Your latest 12 activity entries, across all dates. Activity content is shown as originally recorded.',
  loading: 'Loading your usage…', loadingActivity: 'Loading activity…', retry: 'Try again', refresh: 'Refresh usage',
  error: 'Usage is unavailable right now. Try again shortly.', activityError: 'Activity could not be loaded.',
  empty: 'No recorded AI requests in this period.', noActivity: 'No activity recorded yet.',
  scope: 'Includes completed and failed AI requests recorded for your account. Requests that have not run are excluded. Tokens measure AI input and output; provider usage records may be incomplete.',
  dates: 'Dates use UTC. The current day is still in progress.', details: 'View daily numbers',
} as const

type UsageCopy = Record<keyof typeof en, string>

export const SETTINGS_USAGE_COPY = {
  en,
  de: {
    title: 'Nutzung und Aktivitäten', subtitle: 'Deine erfasste KI-Nutzung in ApplyMate.', period: 'Zeitraum',
    week: 'Letzte 7 Tage', month: 'Letzte 30 Tage', requests: 'KI-Anfragen', input: 'Eingabe-Token', output: 'Ausgabe-Token',
    daily: 'Tägliche Anfragen', models: 'Nutzung nach Modell', model: 'Modell', tokens: 'Token insgesamt', date: 'Datum',
    activity: 'Letzte Aktivitäten', activityHint: 'Deine letzten 12 Aktivitäten, unabhängig vom Zeitraum oben. Aktivitätsinhalte werden wie ursprünglich erfasst angezeigt.',
    loading: 'Nutzung wird geladen…', loadingActivity: 'Aktivitäten werden geladen…', retry: 'Erneut versuchen', refresh: 'Nutzung aktualisieren',
    error: 'Die Nutzung ist derzeit nicht verfügbar. Versuche es später erneut.', activityError: 'Aktivitäten konnten nicht geladen werden.',
    empty: 'In diesem Zeitraum wurden keine KI-Anfragen erfasst.', noActivity: 'Noch keine Aktivitäten erfasst.',
    scope: 'Enthält erfolgreiche und fehlgeschlagene KI-Anfragen, die für dein Konto erfasst wurden. Nicht ausgeführte Anfragen werden nicht gezählt. Token messen KI-Eingaben und -Ausgaben; die Nutzungsdaten des Anbieters können unvollständig sein.',
    dates: 'Datumsangaben verwenden UTC. Der aktuelle Tag ist noch nicht abgeschlossen.', details: 'Tageswerte anzeigen',
  },
  fr: {
    title: 'Utilisation et activité', subtitle: 'Votre utilisation de l’IA enregistrée dans ApplyMate.', period: 'Période',
    week: '7 derniers jours', month: '30 derniers jours', requests: 'Requêtes IA', input: 'Jetons en entrée', output: 'Jetons en sortie',
    daily: 'Requêtes quotidiennes', models: 'Utilisation par modèle', model: 'Modèle', tokens: 'Total de jetons', date: 'Date',
    activity: 'Activité récente', activityHint: 'Vos 12 dernières activités, toutes dates confondues. Leur contenu est affiché tel qu’il a été enregistré.',
    loading: 'Chargement de votre utilisation…', loadingActivity: 'Chargement de l’activité…', retry: 'Réessayer', refresh: 'Actualiser l’utilisation',
    error: 'L’utilisation est momentanément indisponible. Réessayez plus tard.', activityError: 'Impossible de charger l’activité.',
    empty: 'Aucune requête IA enregistrée pendant cette période.', noActivity: 'Aucune activité enregistrée pour le moment.',
    scope: 'Inclut les requêtes IA réussies et échouées enregistrées pour votre compte. Les requêtes non exécutées sont exclues. Les jetons mesurent les entrées et sorties de l’IA ; les données du fournisseur peuvent être incomplètes.',
    dates: 'Les dates sont en UTC. La journée en cours n’est pas terminée.', details: 'Voir les chiffres quotidiens',
  },
  es: {
    title: 'Uso y actividad', subtitle: 'Tu uso de IA registrado en ApplyMate.', period: 'Período',
    week: 'Últimos 7 días', month: 'Últimos 30 días', requests: 'Solicitudes de IA', input: 'Tokens de entrada', output: 'Tokens de salida',
    daily: 'Solicitudes diarias', models: 'Uso por modelo', model: 'Modelo', tokens: 'Tokens totales', date: 'Fecha',
    activity: 'Actividad reciente', activityHint: 'Tus últimas 12 actividades, sin límite de fecha. El contenido se muestra tal como se registró.',
    loading: 'Cargando tu uso…', loadingActivity: 'Cargando actividad…', retry: 'Reintentar', refresh: 'Actualizar uso',
    error: 'El uso no está disponible en este momento. Inténtalo de nuevo más tarde.', activityError: 'No se pudo cargar la actividad.',
    empty: 'No hay solicitudes de IA registradas en este período.', noActivity: 'Aún no hay actividad registrada.',
    scope: 'Incluye las solicitudes de IA completadas correctamente y fallidas registradas en tu cuenta. Se excluyen las solicitudes que no se han ejecutado. Los tokens miden las entradas y salidas de IA; los registros del proveedor pueden estar incompletos.',
    dates: 'Las fechas usan UTC. El día actual todavía no ha terminado.', details: 'Ver cifras diarias',
  },
  nl: {
    title: 'Gebruik en activiteit', subtitle: 'Je geregistreerde AI-gebruik in ApplyMate.', period: 'Periode',
    week: 'Afgelopen 7 dagen', month: 'Afgelopen 30 dagen', requests: 'AI-aanvragen', input: 'Invoertokens', output: 'Uitvoertokens',
    daily: 'Dagelijkse aanvragen', models: 'Gebruik per model', model: 'Model', tokens: 'Totaal aantal tokens', date: 'Datum',
    activity: 'Recente activiteit', activityHint: 'Je laatste 12 activiteiten, ongeacht de periode hierboven. Activiteitsinhoud wordt getoond zoals die is geregistreerd.',
    loading: 'Gebruik laden…', loadingActivity: 'Activiteit laden…', retry: 'Opnieuw proberen', refresh: 'Gebruik vernieuwen',
    error: 'Gebruik is momenteel niet beschikbaar. Probeer het later opnieuw.', activityError: 'Activiteit kon niet worden geladen.',
    empty: 'Geen geregistreerde AI-aanvragen in deze periode.', noActivity: 'Nog geen activiteit geregistreerd.',
    scope: 'Bevat geslaagde en mislukte AI-aanvragen die voor je account zijn geregistreerd. Niet-uitgevoerde aanvragen worden niet meegeteld. Tokens meten AI-invoer en -uitvoer; gebruiksgegevens van de aanbieder kunnen onvolledig zijn.',
    dates: 'Datums gebruiken UTC. De huidige dag is nog niet voorbij.', details: 'Dagelijkse cijfers bekijken',
  },
  zh: {
    title: '使用量与活动', subtitle: '查看你在 ApplyMate 中已记录的 AI 使用情况。', period: '统计时段',
    week: '最近 7 天', month: '最近 30 天', requests: 'AI 请求次数', input: '输入 Token', output: '输出 Token',
    daily: '每日请求', models: '按模型查看用量', model: '模型', tokens: 'Token 总量', date: '日期',
    activity: '最近活动', activityHint: '最近 12 条活动记录，不受上方统计时段限制。活动内容按记录时原文显示。',
    loading: '正在加载使用量…', loadingActivity: '正在加载活动…', retry: '重试', refresh: '刷新使用量',
    error: '暂时无法加载使用量，请稍后重试。', activityError: '暂时无法加载活动记录。',
    empty: '这个时段还没有已记录的 AI 请求。', noActivity: '还没有活动记录。',
    scope: '包含当前账号已记录的成功和失败 AI 请求，尚未执行的请求不计入。Token 用于衡量输入和输出，用量以提供商返回的记录为准，可能不完整。',
    dates: '日期按 UTC 统计，今天的数据仍在更新。', details: '查看每日明细',
  },
} satisfies Record<Lang, UsageCopy>
