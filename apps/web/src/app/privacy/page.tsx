'use client'

import { useI18n } from '@/lib/i18n'

const CONTENT = {
  en: {
    title: 'Privacy Policy', date: 'Effective date: 14 August 2026', contact: 'For privacy questions or data requests, email', brand: 'APPLYMATE AI',
    sections: [
      ['What this policy covers', 'ApplyMate AI helps candidates save job postings, organise applications, tailor resumes, and review assisted form-fill suggestions. This policy covers the ApplyMate website, API, and Chrome extension.'],
      ['Data we handle', ['Account details such as name, email address, authentication records, and plan status.', 'Job-page content that you choose to save, including job title, company, location, URL, salary, and description.', 'Resumes, Persona profile facts, cover letters, application answers, and form fields that you choose to use.', 'Extension settings, extension authentication state, supported-page URLs, and basic operational diagnostics.']],
      ['How we use data', 'We use this data only to provide the user-facing ApplyMate features you request: saving and tracking jobs, generating or revising application materials, matching your profile to a job, and filling application forms for your review. The extension reads supported job pages and, when you grant optional site access and start a form scan, the specific company or ATS page you selected.'],
      ['Sharing and limited use', 'Data is sent to ApplyMate services over HTTPS. When you request an AI feature, the relevant job, resume, Persona, or form information may be processed by the configured AI provider to return that feature’s result. We do not sell personal data, use it for personalised advertising, or use it for advertising attribution.'],
      ['Security and retention', 'Authentication and API traffic use HTTPS in production. Extension tokens are scoped to the ApplyMate account and can be invalidated by signing out or changing account security state. You can manage, export, or delete your account data through the product where those controls are available, or contact us for assistance.'],
      ['Your choices', 'You choose whether to save a job, send material to an AI feature, fill a form, or save a new Persona fact. The extension fills fields for your review; it does not submit an application on your behalf.'],
    ]
  },
  zh: {
    title: '隐私政策', date: '生效日期：2026 年 8 月 14 日', contact: '如有隐私问题或数据请求，请发送邮件至', brand: 'APPLYMATE AI',
    sections: [
      ['本政策适用范围', 'ApplyMate AI 帮助求职者保存职位、整理申请、定制简历并审核辅助填表建议。本政策适用于 ApplyMate 网站、API 和 Chrome 扩展。'],
      ['我们处理的数据', ['账户信息，例如姓名、邮箱、认证记录和套餐状态。', '你选择保存的职位页面内容，包括职位名称、公司、地点、网址、薪资和描述。', '你选择使用的简历、Persona 画像事实、求职信、申请答案和表单字段。', '扩展设置、扩展认证状态、支持的页面网址和基本运行诊断信息。']],
      ['我们如何使用数据', '我们仅使用这些数据来提供你请求的 ApplyMate 功能：保存和跟踪职位、生成或修改申请材料、将你的画像与职位匹配，以及为你审核而填写申请表。扩展只会读取支持的职位页面；当你授予可选的网站访问权限并开始扫描表单时，只读取你选择的公司或 ATS 页面。'],
      ['共享与有限使用', '数据会通过 HTTPS 发送到 ApplyMate 服务。当你请求 AI 功能时，相关职位、简历、Persona 或表单信息可能由配置的 AI 服务商处理，以返回该功能的结果。我们不会出售个人数据，也不会将其用于个性化广告或广告归因。'],
      ['安全与保留', '生产环境中的认证和 API 流量使用 HTTPS。扩展令牌仅绑定到 ApplyMate 账户，退出登录或变更账户安全状态后可以失效。你可以在产品提供相应控制的地方管理、导出或删除账户数据，也可以联系我们获取帮助。'],
      ['你的选择', '你可以决定是否保存职位、将材料发送给 AI 功能、填写表单或保存新的 Persona 事实。扩展会填写字段供你审核，不会代你提交申请。'],
    ]
  }
} as const

export default function PrivacyPage() {
  const { lang } = useI18n()
  const content = CONTENT[lang === 'zh' ? 'zh' : 'en']
  return <main style={{ maxWidth: 820, margin: '0 auto', padding: '56px 24px 80px', color: '#172033', fontFamily: 'system-ui, sans-serif', lineHeight: 1.65 }}>
    <p style={{ color: '#4f46e5', fontWeight: 700, letterSpacing: '.04em' }}>{content.brand}</p>
    <h1 style={{ fontSize: 36, lineHeight: 1.15, margin: '10px 0 12px' }}>{content.title}</h1>
    <p style={{ color: '#526078' }}>{content.date}</p>
    {content.sections.map(([heading, body]) => <section key={heading}><h2>{heading}</h2>{Array.isArray(body) ? <ul>{body.map(item => <li key={item}>{item}</li>)}</ul> : <p>{body}</p>}</section>)}
    <h2>{lang === 'zh' ? '联系我们' : 'Contact'}</h2><p>{content.contact} <a href="mailto:legal@applymate.ai">legal@applymate.ai</a>.</p>
  </main>
}
