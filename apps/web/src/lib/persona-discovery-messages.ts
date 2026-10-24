import type { Lang } from '@/lib/i18n'

export type PersonaDiscoveryMessageKey = 'title' | 'disclosure' | 'useFact' | 'enabled' | 'disabled' | 'loading' | 'empty' | 'loadFailed' | 'saveFailed' | 'stale'

const messages: Record<Lang, Record<PersonaDiscoveryMessageKey, string>> = {
  en: {
    title: 'Discovery preferences',
    disclosure: 'Selected facts are sent to your configured AI model and may appear in the plan and event history of your own discovery Session. These preferences affect new Session snapshots only; existing snapshots are not refreshed. Starting discovery may reuse an existing Session, so data already sent or quoted cannot be recalled. Revoking does not authorize applications or other actions.',
    useFact: 'Use this fact for job discovery', enabled: 'Included in future discovery', disabled: 'Not shared for discovery',
    loading: 'Loading confirmed facts…', empty: 'No current confirmed facts are available to select.',
    loadFailed: 'Could not load discovery consent settings.', saveFailed: 'Could not update discovery consent. No change was applied.',
    stale: 'This fact changed or is no longer current. Your choice was not applied; the list was refreshed.',
  },
  de: {
    title: 'Einstellungen für die Jobsuche',
    disclosure: 'Ausgewählte Fakten werden an dein konfiguriertes KI-Modell gesendet und können im Plan und Ereignisverlauf deiner eigenen Suchsitzung erscheinen. Diese Einstellungen gelten nur für neue Session-Snapshots; bestehende Snapshots werden nicht aktualisiert. Ein Suchstart kann eine bestehende Sitzung wiederverwenden; bereits gesendete oder zitierte Daten lassen sich nicht zurückholen. Ein Widerruf erlaubt keine Bewerbungen oder anderen Aktionen.',
    useFact: 'Diesen Fakt für die Jobsuche verwenden', enabled: 'Für künftige Suchen freigegeben', disabled: 'Nicht für die Suche freigegeben',
    loading: 'Bestätigte Fakten werden geladen…', empty: 'Keine aktuellen bestätigten Fakten zur Auswahl vorhanden.',
    loadFailed: 'Einstellungen zur Suchfreigabe konnten nicht geladen werden.', saveFailed: 'Die Suchfreigabe konnte nicht geändert werden. Es wurde nichts übernommen.',
    stale: 'Dieser Fakt wurde geändert oder ist nicht mehr aktuell. Deine Auswahl wurde nicht übernommen; die Liste wurde aktualisiert.',
  },
  fr: {
    title: 'Préférences de recherche',
    disclosure: 'Les faits sélectionnés sont envoyés à votre modèle d’IA configuré et peuvent apparaître dans le plan et l’historique des événements de votre propre session de recherche. Ces préférences ne s’appliquent qu’aux nouveaux instantanés de session ; les instantanés existants ne sont pas actualisés. Un démarrage peut réutiliser une session existante : les données déjà envoyées ou citées ne peuvent pas être retirées. Le retrait n’autorise aucune candidature ni autre action.',
    useFact: 'Utiliser ce fait pour la recherche d’emploi', enabled: 'Inclus dans les prochaines recherches', disabled: 'Non partagé pour la recherche',
    loading: 'Chargement des faits confirmés…', empty: 'Aucun fait confirmé et actuel à sélectionner.',
    loadFailed: 'Impossible de charger les préférences de consentement.', saveFailed: 'Impossible de modifier le consentement. Aucun changement n’a été appliqué.',
    stale: 'Ce fait a changé ou n’est plus actuel. Votre choix n’a pas été appliqué ; la liste a été actualisée.',
  },
  es: {
    title: 'Preferencias de búsqueda',
    disclosure: 'Los datos seleccionados se envían al modelo de IA configurado y pueden aparecer en el plan y el historial de eventos de tu propia sesión de búsqueda. Estas preferencias solo se aplican a las instantáneas de sesiones nuevas; las existentes no se actualizan. Al iniciar una búsqueda se puede reutilizar una sesión existente, así que los datos ya enviados o citados no se pueden retirar. Revocar no autoriza solicitudes de empleo ni otras acciones.',
    useFact: 'Usar este dato para buscar empleo', enabled: 'Incluido en futuras búsquedas', disabled: 'No se comparte para la búsqueda',
    loading: 'Cargando datos confirmados…', empty: 'No hay datos confirmados y actuales para seleccionar.',
    loadFailed: 'No se pudieron cargar los ajustes de consentimiento.', saveFailed: 'No se pudo cambiar el consentimiento. No se aplicó ningún cambio.',
    stale: 'Este dato cambió o ya no está vigente. No se aplicó tu elección; se actualizó la lista.',
  },
  nl: {
    title: 'Voorkeuren voor zoeken',
    disclosure: 'Geselecteerde feiten worden naar je ingestelde AI-model gestuurd en kunnen verschijnen in het plan en de gebeurtenisgeschiedenis van je eigen zoek-Session. Deze voorkeuren gelden alleen voor nieuwe Session-snapshots; bestaande snapshots worden niet vernieuwd. Een zoekactie kan een bestaande Session hergebruiken, dus reeds verzonden of geciteerde gegevens kunnen niet worden teruggehaald. Intrekken geeft geen toestemming voor sollicitaties of andere acties.',
    useFact: 'Dit feit gebruiken voor het zoeken naar werk', enabled: 'Opgenomen in toekomstige zoekacties', disabled: 'Niet gedeeld voor zoeken',
    loading: 'Bevestigde feiten laden…', empty: 'Er zijn geen actuele bevestigde feiten om te kiezen.',
    loadFailed: 'Instellingen voor zoektoestemming konden niet worden geladen.', saveFailed: 'Zoektoestemming kon niet worden aangepast. Er is niets gewijzigd.',
    stale: 'Dit feit is gewijzigd of niet meer actueel. Je keuze is niet toegepast; de lijst is vernieuwd.',
  },
  zh: {
    title: '职位搜索偏好',
    disclosure: '所选事实会发送给你配置的 AI 模型，并可能出现在你自己的搜索 Session 计划和事件记录中。这些偏好只适用于新建的 Session 快照；现有快照不会更新。开始搜索时可能会复用现有 Session，因此已发送或引用的数据无法撤回。撤销不会授权申请职位或执行其他操作。',
    useFact: '将此事实用于职位搜索', enabled: '将用于后续搜索', disabled: '不会用于职位搜索',
    loading: '正在加载已确认的事实…', empty: '没有可选择的当前已确认事实。',
    loadFailed: '无法加载搜索授权设置。', saveFailed: '无法更新搜索授权，未应用任何更改。',
    stale: '此事实已更改或不再有效。你的选择未应用；列表已刷新。',
  },
}

export function personaDiscoveryMessage(lang: Lang, key: PersonaDiscoveryMessageKey): string {
  return messages[lang][key]
}

export function isDiscoveryPersonaFactEnabled(allowedUses: readonly string[]): boolean {
  return allowedUses.includes('discovery')
}
