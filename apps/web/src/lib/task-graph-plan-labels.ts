import type { Lang } from './i18n'

export const TASK_GRAPH_PLAN_LABELS = {
  en: {
    'agent.taskGraph.currentPlan': 'Current plan',
    'agent.taskGraph.evidenceSummary': 'Evidence summary',
    'agent.taskGraph.dependencies': 'Dependencies',
    'agent.taskGraph.noDependencies': 'No dependencies',
    'agent.taskGraph.statusUnavailable': 'Unavailable',
    'agent.taskGraph.readiness': 'Readiness',
    'agent.taskGraph.readiness.ready': 'Ready to start',
    'agent.taskGraph.readiness.waitingForDependencies': 'Waiting for dependencies',
    'agent.taskGraph.readiness.blockedDependency': 'Blocked by a dependency',
    'agent.taskGraph.readiness.active': 'In progress',
    'agent.taskGraph.readiness.terminal': 'Finished',
    'agent.taskGraph.readiness.unavailable': 'Unavailable',
    'agent.taskGraph.status.queued': 'Queued',
    'agent.taskGraph.status.running': 'Running',
    'agent.taskGraph.status.retrying': 'Retrying',
    'agent.taskGraph.status.waiting': 'Waiting',
    'agent.taskGraph.status.waitingForUser': 'Waiting for you',
    'agent.taskGraph.status.completed': 'Completed',
    'agent.taskGraph.status.failed': 'Failed',
    'agent.taskGraph.status.interrupted': 'Interrupted',
    'agent.taskGraph.status.cancelled': 'Cancelled',
    'agent.taskGraph.status.closed': 'Closed',
  },
  zh: {
    'agent.taskGraph.currentPlan': '当前计划',
    'agent.taskGraph.evidenceSummary': '证据摘要',
    'agent.taskGraph.dependencies': '依赖项',
    'agent.taskGraph.noDependencies': '无依赖项',
    'agent.taskGraph.statusUnavailable': '不可用',
    'agent.taskGraph.readiness': '就绪状态',
    'agent.taskGraph.readiness.ready': '已就绪，可开始',
    'agent.taskGraph.readiness.waitingForDependencies': '等待依赖项完成',
    'agent.taskGraph.readiness.blockedDependency': '被依赖项阻止',
    'agent.taskGraph.readiness.active': '进行中',
    'agent.taskGraph.readiness.terminal': '已结束',
    'agent.taskGraph.readiness.unavailable': '不可用',
    'agent.taskGraph.status.queued': '排队中',
    'agent.taskGraph.status.running': '运行中',
    'agent.taskGraph.status.retrying': '重试中',
    'agent.taskGraph.status.waiting': '等待中',
    'agent.taskGraph.status.waitingForUser': '等待你处理',
    'agent.taskGraph.status.completed': '已完成',
    'agent.taskGraph.status.failed': '失败',
    'agent.taskGraph.status.interrupted': '已中断',
    'agent.taskGraph.status.cancelled': '已取消',
    'agent.taskGraph.status.closed': '已关闭',
  },
} as const satisfies Record<'en' | 'zh', Record<string, string>>

export type TaskGraphPlanLabelKey = keyof typeof TASK_GRAPH_PLAN_LABELS.en

export function taskGraphPlanLabel(lang: Lang, key: TaskGraphPlanLabelKey): string {
  return lang === 'zh' ? TASK_GRAPH_PLAN_LABELS.zh[key] : TASK_GRAPH_PLAN_LABELS.en[key]
}
