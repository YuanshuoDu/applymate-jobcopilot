'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'

const CONTENT = {
  en: {
    title: 'Privacy Policy', date: 'Last updated: 2 November 2026', brand: 'APPLYMATE AI',
    contact: 'For privacy questions or data requests, use the', contactLink: 'public contact form',
    contactDetails: 'Sign-in is not required. In your message, state “Privacy / data request” and include your account email if relevant. The form creates a support case for follow-up.', contactEmail: 'You can also email',
    sections: [
      ['What this policy covers', 'ApplyMate AI helps candidates save job postings, organise applications, tailor resumes, and review assisted form-fill suggestions. This policy covers the ApplyMate website, API, and Chrome extension.'],
      ['Data we handle', [
        'Account details, such as name, email address, authentication records, preferences, and plan status.',
        'Job-page content you save: job title, employer, location, URL, salary, and description.',
        'Resumes, Persona profile facts, cover letters, application answers, and form fields you choose to use. A scan reads supported field labels, options, placeholders, and existing values. AI analysis or revision can send the relevant fields, profile information, and your instructions to the service.',
        'Your profile and application answers can include your location, contact address and salary expectations. Health or disability information may also be included in resumes, Persona facts or answers you choose to provide. The extension can read and display supported existing form answers. If this information is included in a requested AI analysis or revision, it is sent to ApplyMate and the configured AI provider. Saving it in a resume or Persona record retains it with that record; filling it into a third-party application makes it available to that website.',
        'Agent conversations, task records, application status, and saved results when you use those website features; connected-email data when you enable Gmail.',
        'Extension settings, login state, selected-page URLs, and operational records such as feature, model, token count, request status, and timing.',
      ]],
      ['How we use data', 'We use this information to provide the ApplyMate features you request: saving and tracking jobs, preparing application materials, matching your profile, and suggesting form answers. Account and operational records also support authentication, security, usage limits, troubleshooting, and service reliability. Browsing data is used for these visible job-search features, not for unrelated browsing-history collection.'],
      ['AI processing and recipients', [
        'Relevant job, resume, Persona, form, conversation, or selected-email content is sent to the AI provider selected for the feature. The built-in ApplyMate model uses MiniMax by default; a feature setting or configured platform route can select a different provider.',
        'Supported providers are MiniMax, OpenAI, Anthropic, DeepSeek, Alibaba Cloud / Qwen, Z.ai / Zhipu, and Moonshot / Kimi. These are available integrations, not a claim that every provider receives your data. If you configure a custom OpenAI-compatible endpoint, its operator receives the requests routed to that endpoint.',
        'Review the provider and endpoint in Settings → API Keys / AI Models before using AI with personal information. Provider processing locations and retention depend on the selected service and account configuration. ApplyMate does not promise that all AI processing occurs in the EU or that every provider retains no data.',
      ]],
      ['Hosting and other service providers', [
        'The application integrates Vercel for web/API hosting and optional performance measurements, Neon PostgreSQL for stored account and application records, Fly.io for background workers, Upstash / Redis for caching and queued work, and Microsoft Azure Key Vault for protecting service credentials. The relevant enabled service processes the requests, records, tasks, or protected credential material needed for its role.',
        'Resend processes recipient addresses and message content for configured transactional or support emails. Google handles Google sign-in and connected Gmail operations; GitHub handles GitHub sign-in or connected-account requests. Chrome sync storage is provided by Google.',
        'Requested job searches can send search terms and location filters to configured discovery providers, including Adzuna, RapidAPI-hosted services, and employer recruitment systems. Filling a third-party application makes the entered information available to that website; its own data practices also apply.',
      ]],
      ['Optional Gmail connection', 'Connecting Gmail authorises mailbox access separately from ordinary sign-in. Gmail features can read messages, save recruitment-message metadata and excerpts, match replies to applications, and create or send drafts at your request. Asking for an AI reply can send the selected message and sender details to the chosen AI provider. Disconnect Gmail in Settings → Connected Accounts to remove ApplyMate’s saved Gmail credentials. You can also revoke access in your Google Account. Disconnecting does not erase previously saved recruitment records; use the deletion controls below for those records.'],
      ['Chrome Web Store and Google API Limited Use', 'ApplyMate’s use and transfer of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. Our use and transfer of information received from Google APIs also adheres to the Google API Services User Data Policy, including its Limited Use requirements. We do not sell personal data or use it for personalised advertising, advertising attribution, creditworthiness, or lending decisions. ApplyMate does not use your CVs or Google user data to train general-purpose AI models; the in-product AI-training option is unavailable.'],
      ['Browser storage and site access', 'The extension stores settings, account details, and its authentication token in Chrome sync storage, which may synchronise between your signed-in browsers according to your Chrome settings. Job caches, the selected resume, and resume drafts use local extension storage. Additional career-site access is requested for the specific site you choose. If you choose to discover embedded application frames and grant the optional navigation permission, their URLs are read for local permission selection and frame routing, not synchronised as browsing history. You can grant each additional site separately and review or revoke site access in Chrome. A broader all-sites permission granted to an earlier version may remain until you use the extension’s removal control or revoke it in Chrome; upgrading does not automatically remove it.'],
      ['Retention and deletion', [
        'Saved profiles, jobs, resumes, cover letters, application history, and recruitment-email records remain available until you remove the relevant record or delete your account. Local extension resume drafts older than 24 hours are discarded when accessed. Signing out clears the current account’s local extension cache and saved login state; it does not itself revoke every previously issued server token. Token expiry and account-security checks still apply.',
        'Settings → Privacy offers Download my data, Request data deletion, and Delete account. The export includes supported account and application records while excluding passwords and secret credentials. Request data deletion records a request for follow-up; it does not immediately erase the account. Delete account requires your email confirmation and removes the account and related account-owned records from the active database.',
        'Some operational, usage, and audit records are retained separately, including usage records whose account reference is removed on deletion. Completed or cancelled deletion-queue records have a configurable retention policy, with a 90-day default; this is not a 90-day expiry for all user data. Provider-held copies and records already sent to an employer are not erased by deleting an ApplyMate account. Contact us about retention or deletion questions, including any remaining records.',
        'Turning off Retain generated cover letters removes non-final AI-generated letters after an application is recorded as submitted; final or manually maintained documents remain. This setting does not delete all existing letters immediately.',
      ]],
      ['Analytics and security', 'Production authentication and API traffic use HTTPS. Saved provider keys and OAuth credentials use application-layer encryption. In Settings → Privacy, Share anonymous usage data controls optional Vercel Speed Insights for signed-in users. The current default is enabled where no preference has been saved; this analytics client is not enabled for anonymous visits. Security, request accounting, and essential service records are separate from this optional measurement setting.'],
      ['Your choices', 'You choose whether to save a job, request an AI result, fill a form, or save a Persona fact. The Chrome extension fills fields for your review and does not submit an application. Separate website and worker tasks follow their own task and approval settings. You can manage profile and saved materials in the product, disconnect integrations, disable optional analytics, and use the export or deletion controls.'],
    ]
  },
  zh: {
    title: '隐私政策', date: '更新日期：2026 年 11 月 2 日', brand: 'APPLYMATE AI',
    contact: '如有隐私问题或数据请求，请使用', contactLink: '公开联系表单',
    contactDetails: '无需登录。请在留言中注明“隐私 / 数据请求”，如与账户有关，请提供该账户的邮箱。表单会创建支持工单以便后续处理。', contactEmail: '你也可以发送邮件至',
    sections: [
      ['本政策适用范围', 'ApplyMate AI 帮助求职者保存职位、整理申请、定制简历并审核辅助填表建议。本政策适用于 ApplyMate 网站、API 和 Chrome 扩展。'],
      ['我们处理的数据', [
        '账户资料，例如姓名、邮箱、认证记录、偏好及套餐状态。',
        '你保存的职位页面内容，包括职位名称、雇主、地点、网址、薪资和描述。',
        '你选择使用的简历、Persona 画像、求职信、申请答案和表单字段。扫描读取支持的字段标签、选项、占位提示及已有值。AI 分析或修改可以把相关字段、个人资料和指令发送至服务。',
        '个人资料和申请答案可以包含你的所在地、联系地址和薪资期望。你选择提供的简历、Persona 事实或答案也可能包含健康或残障信息。扩展可以读取和显示支持的已有表单答案。如果请求的 AI 分析或修改包含这些信息，相关内容会发送至 ApplyMate 和该功能配置的 AI 服务商。将其保存为简历或 Persona 记录的一部分后，信息会随该记录保留；填入第三方申请页面后，该网站可以访问这些信息。',
        '使用网站相关功能时的 Agent 对话、任务记录、申请状态和保存结果；启用 Gmail 时的关联邮件数据。',
        '扩展设置、登录状态、所选页面网址，以及功能、模型、用量、请求状态和耗时等运行记录。',
      ]],
      ['我们如何使用数据', '这些信息用于你请求的 ApplyMate 功能：保存和跟踪职位、准备申请材料、匹配个人资料和建议表单答案。账户及运行记录也用于认证、安全、用量限制、故障排查和服务可靠性。浏览数据用于这些可见的求职功能，不用于无关的浏览历史收集。'],
      ['AI 处理与接收方', [
        '相关职位、简历、Persona、表单、对话或所选邮件内容会发送至该功能选用的 AI 服务商。内置 ApplyMate 模型默认使用 MiniMax；功能设置或平台配置的路由可以选择其他服务商。',
        '支持的服务商包括 MiniMax、OpenAI、Anthropic、DeepSeek、阿里云 / Qwen、Z.ai / 智谱和 Moonshot / Kimi。这是可用集成列表，并不表示每家都会接收你的数据。如果你配置自定义 OpenAI 兼容端点，该端点的运营方会接收路由到它的请求。',
        '使用含个人信息的 AI 功能前，请在“设置 → API Keys / AI Models”中查看服务商和端点。处理地点与保留期限取决于所选服务和账户配置。ApplyMate 不承诺所有 AI 处理都在欧盟进行，也不承诺所有服务商均为零数据保留。',
      ]],
      ['托管与其他服务商', [
        '应用集成 Vercel（网站、API 托管及可选性能测量）、Neon PostgreSQL（账户与申请记录存储）、Fly.io（后台任务）、Upstash / Redis（缓存及任务队列）和 Microsoft Azure Key Vault（保护服务凭据）。相应启用的服务会处理其职责所需的请求、记录、任务或受保护的凭据材料。',
        'Resend 为配置的事务或支持邮件处理收件地址和邮件内容。Google 提供 Google 登录及关联 Gmail 操作；GitHub 提供 GitHub 登录或关联账户请求。Chrome 同步存储由 Google 提供。',
        '你请求职位搜索时，搜索词和地点筛选条件可以发送至配置的搜索来源，包括 Adzuna、RapidAPI 上的服务以及雇主招聘系统。将信息填入第三方申请页面后，该网站可以访问这些信息，其数据规则同样适用。',
      ]],
      ['可选 Gmail 连接', '关联 Gmail 的邮箱授权与普通登录分开。Gmail 功能可以读取邮件、保存招聘邮件的元数据与摘要、匹配申请回复，并按你的请求创建或发送草稿。请求 AI 回复时，所选邮件及发件人信息可以发送给所选 AI 服务商。在“设置 → 关联账户”中断开 Gmail 会移除 ApplyMate 保存的 Gmail 凭据；你也可以在 Google 账户中撤销授权。断开连接不会清除已保存的招聘记录，删除这些记录请使用下述控制。'],
      ['Chrome 商店与 Google API 有限使用', 'ApplyMate 对通过 Chrome API 获取的信息的使用和转移遵守 Chrome Web Store User Data Policy，包括 Limited Use 要求。对通过 Google API 获取的信息的使用和转移同样遵守 Google API Services User Data Policy 及其 Limited Use 要求。我们不出售个人数据，也不将其用于个性化广告、广告归因、信用评估或贷款决策。ApplyMate 不使用你的简历或 Google 用户数据训练通用 AI 模型；产品内的 AI 训练选项不可用。'],
      ['浏览器存储与网站访问', '扩展将设置、账户资料及认证令牌保存到 Chrome 同步存储，可以根据 Chrome 设置在已登录的浏览器间同步。职位缓存、所选简历及简历草稿保存在扩展本地存储。其他招聘网站权限按你选择的具体站点申请。如果你主动选择发现嵌入式申请框架并授予可选的导航权限，其网址仅用于本地权限选择及框架路由，不作为浏览历史同步。你可以分别授权其他站点，并在 Chrome 中查看或撤销网站权限。旧版获准的所有网站权限可能继续存在，直到你使用扩展的移除控制或在 Chrome 中撤销；升级不会自动移除旧权限。'],
      ['保留与删除', [
        '保存的个人资料、职位、简历、求职信、申请历史及招聘邮件记录会保留，直到你删除相应记录或账户。扩展本地简历草稿在访问时如已超过 24 小时会被丢弃。退出登录会清除当前账户的扩展本地缓存与保存的登录状态，但不会单独撤销所有已签发的服务端令牌；令牌到期及账户安全检查仍然生效。',
        '“设置 → 隐私”提供下载数据、请求删除数据及删除账户。导出包含支持的账户和申请记录，不包含密码及秘密凭据。“请求删除数据”仅登记等待跟进的请求，不会立即删除账户。“删除账户”需要邮箱确认，会从当前数据库删除账户及关联的账户所属记录。',
        '部分运行、用量和审计记录独立保留，包括在删除账户时移除账户关联的用量记录。已完成或取消的删除队列记录有可配置的保留期限，默认为 90 天；这不代表所有用户数据都在 90 天后删除。删除 ApplyMate 账户不会删除服务商持有的副本或已发送给雇主的记录。如需了解保留期限、删除或剩余记录，请联系我们。',
        '关闭“保留生成的求职信”后，申请记为已提交时会删除非最终版 AI 求职信；最终版及手工维护的文件保留。这一设置不会立即删除所有历史求职信。',
      ]],
      ['分析与安全', '生产环境的认证和 API 流量使用 HTTPS。保存的服务商密钥及 OAuth 凭据使用应用层加密。“设置 → 隐私”中的“分享匿名使用数据”控制已登录用户的可选 Vercel Speed Insights。尚未保存偏好时，当前默认启用；匿名访问不会启用该分析客户端。安全、请求计量及必要的服务记录与这一可选测量设置分开处理。'],
      ['你的选择', '你可以决定是否保存职位、请求 AI 结果、填写表单或保存 Persona 事实。Chrome 扩展填写字段供你审核，不会提交申请。独立的网站和后台任务使用其各自的任务及审批设置。你可以在产品中管理个人资料和材料、断开集成、关闭可选分析，并使用导出或删除功能。'],
    ]
  }
} as const

export default function PrivacyPage() {
  const { lang } = useI18n()
  const content = CONTENT[lang === 'zh' ? 'zh' : 'en']
  return <main style={{ maxWidth: 900, minHeight: '100vh', margin: '0 auto', padding: '56px 32px 80px', background: '#fff', color: '#172033', fontFamily: 'system-ui, sans-serif', fontSize: 15, lineHeight: 1.7 }}>
    <p style={{ color: '#4f46e5', fontWeight: 700, letterSpacing: '.04em' }}>{content.brand}</p>
    <h1 style={{ fontSize: 36, lineHeight: 1.15, margin: '10px 0 12px' }}>{content.title}</h1>
    <p style={{ color: '#526078' }}>{content.date}</p>
    {content.sections.map(([heading, body]) => <section key={heading} style={{ marginTop: 28 }}><h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{heading}</h2>{Array.isArray(body) ? <ul style={{ paddingLeft: 22, listStyleType: 'disc' }}>{body.map(item => <li key={item} style={{ marginBottom: 9 }}>{item}</li>)}</ul> : <p>{body}</p>}</section>)}
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{lang === 'zh' ? '联系我们' : 'Contact'}</h2>
      <p>{content.contact} <a style={{ color: '#4f46e5', textDecoration: 'underline' }} href="/landing#contact">{content.contactLink}</a>{lang === 'zh' ? '。' : '. '}{content.contactDetails}</p>
      <p>{content.contactEmail} <a style={{ color: '#4f46e5', textDecoration: 'underline' }} href="mailto:legal@applymate.ai">legal@applymate.ai</a>.</p>
    </section>
  </main>
}
