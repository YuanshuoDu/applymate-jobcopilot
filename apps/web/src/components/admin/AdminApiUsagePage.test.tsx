import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => ({ 'apiUsage.title': 'API 用量中心', 'apiUsage.subtitle': '实时用量', 'apiUsage.privacyTitle': '隐私安全。', 'apiUsage.privacy': '仅保存运行元数据。', 'apiUsage.refresh': '刷新', 'apiUsage.category': '类别', 'apiUsage.jobApis': '职位 API', 'apiUsage.modelApis': '模型 API', 'apiUsage.range': '天数', 'apiUsage.updated': '更新时间', 'apiUsage.autoRefresh': '自动刷新', 'apiUsage.calls': '请求次数', 'apiUsage.days': '天', 'apiUsage.jobsReturned': '返回职位数', 'apiUsage.rawResults': '原始结果', 'apiUsage.errors': '错误数', 'apiUsage.providers': '供应商', 'apiUsage.ownershipTracked': '归属', 'apiUsage.quotas': '额度', 'apiUsage.quotaHelp': '平台额度', 'apiUsage.trend': '趋势', 'apiUsage.noData': '暂无数据', 'apiUsage.breakdown': '明细', 'apiUsage.provider': '供应商', 'apiUsage.operationModel': '操作', 'apiUsage.owner': '归属', 'apiUsage.latency': '延迟' }[key] ?? key) }) }))
import { AdminApiUsagePage } from './AdminApiUsagePage'

describe('AdminApiUsagePage', () => {
  it('renders a locale-consistent job/model API dashboard shell', () => {
    const html = renderToStaticMarkup(<AdminApiUsagePage canUpdateAi={false} canUpdateJob={false} />)
    expect(html).toContain('API 用量中心')
    expect(html).toContain('职位 API')
    expect(html).toContain('模型 API')
    expect(html).toContain('仅保存运行元数据')
    expect(html).toContain('apiUsage.filterProvider')
  })
})
