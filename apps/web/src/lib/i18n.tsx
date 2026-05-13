'use client'
import React, { createContext, useContext, useState, useCallback } from 'react'

export type Lang = 'en' | 'zh'

// ── Translations dictionary ──────────────────────────────────────────────────
const dict: Record<Lang, Record<string, string>> = {
  en: {
    'nav.dashboard':     'Dashboard',
    'nav.jobs':          'My Jobs',
    'nav.search':        'Search Jobs',
    'nav.resume':        'Resume',
    'nav.gmail':         'Gmail',
    'nav.agent':         'Agent',
    'nav.extension':     'Extension',
    'nav.settings':      'Settings',
    'search.title':      'Search Jobs',
    'search.placeholder':'e.g. "React Developer Dublin"',
    'search.btn':        'Search Jobs',
    'search.filters':    'Filters',
    'search.clearFilter':'Clear all',
    'search.recent':     'Recent:',
    'search.clearHist':  'Clear history',
    'search.clear':      'Clear search',
    'search.noResults':  'No matching jobs found',
    'search.tryBroader': 'Try broader keywords or a different location',
    'search.emptyTitle': 'AI-Powered Job Search',
    'search.emptyDesc':  'Search across 14 job sources simultaneously.',
    'search.loading':    'AI analysing your search, routing to best sources…',
    'search.results':    'jobs found',
    'search.via':        'via',
    'search.market':     'Market:',
    'search.trending':   'Trending skills:',
    'search.skills':     'Skills Required',
    'search.desc':       'Job Description',
    'search.descPreview':'Preview — click View Job for full posting',
    'search.noDesc':     'No description available.',
    'search.hm':         'Hiring Manager',
    'search.viewJob':    'View Original Job Posting',
    'search.save':       'Save',
    'search.saved':      'Saved',
    'search.scoring':    'AI scoring…',
    'search.expand':     'Show full description + translate',
    'search.collapse':   'Collapse',
    'search.translate':  'Translate',
    'search.translating':'Translating…',
    'search.transTo':    'to',
    'search.directApply':'Direct Apply',
    'jobs.title':        'My Jobs',
    'jobs.search':       'Search jobs…',
    'jobs.all':          'All',
    'jobs.saved':        'Saved',
    'jobs.applied':      'Applied',
    'jobs.review':       'In Review',
    'jobs.interview':    'Interview',
    'jobs.offer':        'Offer received',
    'jobs.rejected':     'Rejected',
    'jobs.add':          '+ Add Job',
    'jobs.noJobs':       'No jobs found',
    'jobs.loading':      'Loading jobs…',
    'jobs.sort.date':    'Date',
    'jobs.sort.score':   'Score',
    'jobs.sort.company': 'Company',
    'jobs.sort.role':    'Role',
    'jobs.sort.label':   'Sort:',
    'jobs.perPage':      '/ page',
    'jobs.translate':    'Translate',
    'jobs.viewOriginal': 'View Original',
    'common.saving':     'Saving…',
    'common.saveFailed': 'Save failed',
    'common.saved':      'Saved',
    'common.cancel':     'Cancel',
    'common.retry':      'Retry',
    'lang.switch':       '中文',
  },
  zh: {
    'nav.dashboard':     '仪表板',
    'nav.jobs':          '我的职位',
    'nav.search':        '搜索职位',
    'nav.resume':        '简历',
    'nav.gmail':         '邮箱',
    'nav.agent':         '智能体',
    'nav.extension':     '扩展',
    'nav.settings':      '设置',
    'search.title':      '搜索职位',
    'search.placeholder':'例如 "React Developer Dublin"',
    'search.btn':        '搜索职位',
    'search.filters':    '筛选',
    'search.clearFilter':'清除全部',
    'search.recent':     '最近:',
    'search.clearHist':  '清除历史',
    'search.clear':      '清除搜索',
    'search.noResults':  '未找到匹配职位',
    'search.tryBroader': '尝试更宽泛的关键词或不同地点',
    'search.emptyTitle': 'AI 聚合搜索',
    'search.emptyDesc':  '同时搜索 14 个职位数据源，AI 智能路由去重。',
    'search.loading':    'AI 正在分析搜索意图，选择最优数据源…',
    'search.results':    '个职位',
    'search.via':        '来源',
    'search.market':     '市场薪资:',
    'search.trending':   '热门技能:',
    'search.skills':     '技能要求',
    'search.desc':       '职位描述',
    'search.descPreview':'预览 — 点击 View Job 查看完整信息',
    'search.noDesc':     '暂无职位描述。',
    'search.hm':         '招聘负责人',
    'search.viewJob':    '查看原始职位',
    'search.save':       '保存',
    'search.saved':      '已保存',
    'search.scoring':    'AI 评分中…',
    'search.expand':     '展开全文 + 翻译',
    'search.collapse':   '收起',
    'search.translate':  '翻译',
    'search.translating':'翻译中…',
    'search.transTo':    '翻译为',
    'search.directApply':'直接投递',
    'jobs.title':        '我的职位',
    'jobs.search':       '搜索职位…',
    'jobs.all':          '全部',
    'jobs.saved':        '已保存',
    'jobs.applied':      '已投递',
    'jobs.review':       '审核中',
    'jobs.interview':    '面试中',
    'jobs.offer':        '已获Offer',
    'jobs.rejected':     '已拒绝',
    'jobs.add':          '+ 添加职位',
    'jobs.noJobs':       '暂无职位',
    'jobs.loading':      '加载中…',
    'jobs.sort.date':    '日期',
    'jobs.sort.score':   '分数',
    'jobs.sort.company': '公司',
    'jobs.sort.role':    '职位',
    'jobs.sort.label':   '排序:',
    'jobs.perPage':      '条/页',
    'jobs.translate':    '翻译',
    'jobs.viewOriginal': '查看原文',
    'common.saving':     '保存中…',
    'common.saveFailed': '保存失败',
    'common.saved':      '已保存',
    'common.cancel':     '取消',
    'common.retry':      '重试',
    'lang.switch':       'English',
  },
}

// ── Context ──────────────────────────────────────────────────────────────────

interface I18nContextValue {
  lang: Lang
  t:    (key: string) => string
  setLang: (l: Lang) => void
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'en',
  t:    (key) => key,
  setLang: () => {},
})

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('applymate_lang') as Lang) ?? 'en'
    }
    return 'en'
  })

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try { localStorage.setItem('applymate_lang', l) } catch {}
  }, [])

  const t = useCallback((key: string): string => {
    return dict[lang]?.[key] ?? dict.en?.[key] ?? key
  }, [lang])

  return React.createElement(I18nContext.Provider, { value: { lang, t, setLang } }, children)
}

export function useI18n() {
  return useContext(I18nContext)
}

// ── Quick accessors for common lookup ────────────────────────────────────────

export const LANG_LABELS: Record<string, string> = {
  zh: '中文', en: 'English', de: 'Deutsch', fr: 'Français',
  es: 'Español', ja: '日本語', ko: '한국어', pt: 'Português',
}

export const SEARCH_TARGET_LANGS: { value: string; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'ja', label: '日本語' },
]
