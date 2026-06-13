/**
 * ApplyMate AI 功能连通性测试
 * 运行: node test-ai.mjs
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env.local')
const env = {}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/); if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
}

const MINIMAX_KEY  = env.MINIMAX_API_KEY  || ''
const DEEPSEEK_KEY = env.DEEPSEEK_API_KEY || ''

const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m'; const C = '\x1b[36m'; const X = '\x1b[0m'

async function chat(base, key, model, prompt, max = 300) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: max, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status}: ${t.slice(0, 150)}`) }
  return (await res.json()).choices?.[0]?.message?.content ?? ''
}

async function chatStream(base, key, model, prompt, max = 400) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: max, stream: true, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status}: ${t.slice(0, 150)}`) }

  const reader = res.body.getReader(); const dec = new TextDecoder(); let full = '', lb = ''
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    lb += dec.decode(value, { stream: true })
    const lines = lb.split('\n'); lb = lines.pop() ?? ''
    for (const ln of lines) {
      if (!ln.startsWith('data: ')) continue
      const p = ln.slice(6).trim(); if (p === '[DONE]') break
      try { const d = JSON.parse(p).choices?.[0]?.delta?.content; if (d) full += d } catch { /* skip */ }
    }
  }
  reader.releaseLock()

  // Strip think blocks (same as model-router stripThinkStream)
  let out = '', inThink = false, buf = full
  while (buf.length > 0) {
    if (!inThink) {
      const i = buf.indexOf('<think>'); if (i === -1) { out += buf; break }
      out += buf.slice(0, i); buf = buf.slice(i + 7); inThink = true
    } else {
      const i = buf.indexOf('</think>'); if (i === -1) { buf = ''; break }
      buf = buf.slice(i + 8); inThink = false
    }
  }
  return { raw: full, stripped: out.trim() }
}

const TESTS = [
  {
    name: '① ApplyMate 默认 — MiniMax M2.7 普通调用',
    skip: !MINIMAX_KEY,
    fn: async () => {
      const raw = await chat('https://api.minimax.chat/v1', MINIMAX_KEY, 'MiniMax-M2.7', 'Reply with only: "MiniMax OK"')
      const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      if (!stripped) throw new Error(`空回复（原始 ${raw.length} 字符，含 think=${raw.includes('<think>')}）`)
      return stripped.slice(0, 60)
    },
  },
  {
    name: '② ApplyMate 默认 — MiniMax M2.7 流式 + think 块过滤',
    skip: !MINIMAX_KEY,
    fn: async () => {
      const { raw, stripped } = await chatStream('https://api.minimax.chat/v1', MINIMAX_KEY, 'MiniMax-M2.7',
        'Reply with only the text: "Stream OK"')
      if (stripped.includes('<think>')) throw new Error(`think 块未过滤: ${stripped.slice(0, 80)}`)
      if (!stripped) throw new Error(`过滤后为空（原始含 think=${raw.includes('<think>')}）`)
      return `think 过滤=${raw.includes('<think>')} → "${stripped.slice(0, 50)}"`
    },
  },
  {
    name: '③ JSON 结构化输出 — 简历评分 (MiniMax M2.7)',
    skip: !MINIMAX_KEY,
    fn: async () => {
      const raw = await chat('https://api.minimax.chat/v1', MINIMAX_KEY, 'MiniMax-M2.7',
        'Return ONLY valid JSON, no markdown:\n{"score":85,"matched":["Python","REST API"],"missing":["Docker","K8s"]}', 400)
      const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?\n?|\n?```$/g, '').trim()
      const p = JSON.parse(clean)
      if (typeof p.score !== 'number' || !Array.isArray(p.matched)) throw new Error('JSON 结构错误')
      return `score=${p.score}, matched=[${p.matched.join(',')}], missing=[${p.missing.join(',')}]`
    },
  },
  {
    name: '④ 求职信生成 — MiniMax M2.7',
    skip: !MINIMAX_KEY,
    fn: async () => {
      const raw = await chat('https://api.minimax.chat/v1', MINIMAX_KEY, 'MiniMax-M2.7',
        'Write one sentence cover letter for Backend Engineer at Stripe.', 4096)
      const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      if (text.length < 30) throw new Error(`回复过短(${text.length}字符): "${text}"`)
      return text.slice(0, 80) + (text.length > 80 ? '…' : '')
    },
  },
  {
    name: '⑤ DeepSeek V4 Flash — 普通调用',
    skip: !DEEPSEEK_KEY,
    fn: async () => {
      const raw = await chat('https://api.deepseek.com/v1', DEEPSEEK_KEY, 'deepseek-v4-flash',
        'Reply with only: "Flash OK"')
      if (!raw.trim()) throw new Error('回复为空')
      return raw.trim().slice(0, 60)
    },
  },
  {
    name: '⑥ DeepSeek V4 Pro — 流式调用',
    skip: !DEEPSEEK_KEY,
    fn: async () => {
      const { stripped } = await chatStream('https://api.deepseek.com/v1', DEEPSEEK_KEY, 'deepseek-v4-pro',
        'Reply with only: "Pro Stream OK"', 100)
      if (!stripped) throw new Error('回复为空')
      return stripped.slice(0, 60)
    },
  },
  {
    name: '⑦ DeepSeek V4 Pro JSON — 简历评分',
    skip: !DEEPSEEK_KEY,
    fn: async () => {
      const raw = await chat('https://api.deepseek.com/v1', DEEPSEEK_KEY, 'deepseek-v4-pro',
        'Return ONLY valid JSON no markdown:\n{"score":72,"matched":["Node.js","TypeScript"],"missing":["AWS","Redis"]}', 300)
      const p = JSON.parse(raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim())
      if (typeof p.score !== 'number') throw new Error('score 字段缺失')
      return `score=${p.score}`
    },
  },
  {
    name: '⑧ Agent 流式对话 (MiniMax M2.7 + system prompt)',
    skip: !MINIMAX_KEY,
    fn: async () => {
      const { stripped } = await chatStream('https://api.minimax.chat/v1', MINIMAX_KEY, 'MiniMax-M2.7',
        JSON.stringify([{ role: 'system', content: 'You are a job search assistant.' },
                        { role: 'user',   content: 'How many jobs in my pipeline? Just say: "Pipeline test OK"' }]),
        300)
      // 实际 agent 把 system+messages 传进去；这里只测流式是否正常
      const { stripped: s2 } = await chatStream('https://api.minimax.chat/v1', MINIMAX_KEY, 'MiniMax-M2.7',
        'You are a job assistant. Say: "Agent OK"', 200)
      if (!s2) throw new Error('Agent 流式回复为空')
      return `"${s2.slice(0, 50)}"`
    },
  },
]

console.log(`\n${C}╔══════════════════════════════════════════════════╗`)
console.log(`║   ApplyMate AI 功能测试  ${new Date().toLocaleTimeString()}            ║`)
console.log(`╚══════════════════════════════════════════════════╝${X}\n`)
console.log(`  MiniMax  key: ${MINIMAX_KEY  ? G+'已配置'+X : R+'未配置'+X}`)
console.log(`  DeepSeek key: ${DEEPSEEK_KEY ? G+'已配置'+X : R+'未配置'+X}\n`)

let passed = 0, failed = 0, skipped = 0
for (const t of TESTS) {
  process.stdout.write(`${Y}${t.name}${X}\n`)
  if (t.skip) { console.log(`${Y}  ⚠ 跳过（Key 未配置）${X}\n`); skipped++; continue }
  const start = Date.now()
  try {
    const result = await t.fn()
    console.log(`${G}  ✓ ${String(result)}${X}  ${String(Date.now()-start)}ms\n`)
    passed++
  } catch (e) {
    console.log(`${R}  ✗ ${String(e.message).slice(0, 160)}${X}\n`)
    failed++
  }
}

console.log(`${C}══════════════════════════════════════════════════${X}`)
console.log(`通过 ${G}${passed}${X}  失败 ${failed > 0 ? R : X}${failed}${X}  跳过 ${Y}${skipped}${X}\n`)
if (failed === 0 && skipped === 0) console.log(`${G}✓ 全部通过，所有 AI 功能正常可用${X}\n`)
