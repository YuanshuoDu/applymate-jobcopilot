/**
 * Prisma seed script — ApplyMate AI
 * Run: pnpm prisma db seed
 */
import { PrismaClient, JobStatus, JobWorkflowState, ActivityType, Plan, PlanEntitlementKind } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { seedAiConfiguration } from './seed-ai'

const db = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  const aiSeed = await seedAiConfiguration(db as never)
  console.log(`✓ AI catalogue: ${aiSeed.providerCount} providers, ${aiSeed.modelCount} models, ${aiSeed.routeCount} routes`)

  const planSeeds = [
    { plan: Plan.free, name: 'Free', description: 'A starter workspace for manual applications.', monthlyPriceCents: 0, yearlyPriceCents: 0, entitlements: [{ featureKey: 'ai_credits', kind: PlanEntitlementKind.limit, enabled: true, limit: 25 }, { featureKey: 'job_discovery', kind: PlanEntitlementKind.limit, enabled: true, limit: 20 }, { featureKey: 'auto_apply', kind: PlanEntitlementKind.boolean, enabled: false }, { featureKey: 'tailored_resume', kind: PlanEntitlementKind.boolean, enabled: true }, { featureKey: 'cover_letter', kind: PlanEntitlementKind.limit, enabled: true, limit: 5 }, { featureKey: 'gmail_tracking', kind: PlanEntitlementKind.boolean, enabled: false }, { featureKey: 'api_access', kind: PlanEntitlementKind.boolean, enabled: false }] },
    { plan: Plan.pro, name: 'Pro', description: 'Full AI-assisted job search and applications.', monthlyPriceCents: 1900, yearlyPriceCents: 19000, entitlements: [{ featureKey: 'ai_credits', kind: PlanEntitlementKind.limit, enabled: true, limit: 1000 }, { featureKey: 'job_discovery', kind: PlanEntitlementKind.limit, enabled: true, limit: 1000 }, { featureKey: 'auto_apply', kind: PlanEntitlementKind.boolean, enabled: true }, { featureKey: 'tailored_resume', kind: PlanEntitlementKind.boolean, enabled: true }, { featureKey: 'cover_letter', kind: PlanEntitlementKind.limit, enabled: true, limit: 100 }, { featureKey: 'gmail_tracking', kind: PlanEntitlementKind.boolean, enabled: true }, { featureKey: 'api_access', kind: PlanEntitlementKind.boolean, enabled: false }] },
    { plan: Plan.enterprise, name: 'Enterprise', description: 'High-volume controls for teams and managed accounts.', monthlyPriceCents: 4900, yearlyPriceCents: 49000, entitlements: [{ featureKey: 'ai_credits', kind: PlanEntitlementKind.limit, enabled: true, limit: 10000 }, { featureKey: 'job_discovery', kind: PlanEntitlementKind.limit, enabled: true, limit: 10000 }, { featureKey: 'auto_apply', kind: PlanEntitlementKind.boolean, enabled: true }, { featureKey: 'tailored_resume', kind: PlanEntitlementKind.boolean, enabled: true }, { featureKey: 'cover_letter', kind: PlanEntitlementKind.limit, enabled: true, limit: 1000 }, { featureKey: 'gmail_tracking', kind: PlanEntitlementKind.boolean, enabled: true }, { featureKey: 'api_access', kind: PlanEntitlementKind.boolean, enabled: true }] },
  ] as const
  const planRows = new Map<Plan, { id: string }>()
  for (const seed of planSeeds) {
    const row = await db.planCatalog.upsert({ where: { plan: seed.plan }, update: {}, create: { plan: seed.plan, name: seed.name, description: seed.description, monthlyPriceCents: seed.monthlyPriceCents, yearlyPriceCents: seed.yearlyPriceCents, currency: 'EUR', active: true }, select: { id: true } })
    planRows.set(seed.plan, row)
    for (const entitlement of seed.entitlements) await db.planEntitlement.upsert({ where: { planId_featureKey: { planId: row.id, featureKey: entitlement.featureKey } }, update: {}, create: { planId: row.id, ...entitlement } })
  }
  for (const fromPlan of Object.values(Plan)) for (const toPlan of Object.values(Plan)) if (fromPlan !== toPlan) await db.planTransition.upsert({ where: { fromPlan_toPlan: { fromPlan, toPlan } }, update: {}, create: { fromPlan, toPlan, enabled: true } })
  console.log(`✓ Plan catalogue: ${planRows.size} plans`)

  // ── Demo user ─────────────────────────────────────────────
  const password = await bcrypt.hash('demo1234', 12)
  const user = await db.user.upsert({
    where: { email: 'demo@applymate.ai' },
    update: {
      name: 'Zhang Li',
      plan: 'pro',
      password,
      onboardedAt: new Date(),
    },
    create: {
      email: 'demo@applymate.ai',
      name: 'Zhang Li',
      plan: 'pro',
      password,
      onboardedAt: new Date(),
    },
  })
  console.log(`✓ User: ${user.email}`)

  // ── Jobs ──────────────────────────────────────────────────
  const jobsData = [
    { company: 'Adyen',       logo: 'AD', role: 'Backend Engineer',         location: 'Amsterdam, NL', status: 'interview' as JobStatus, score: 91, salary: '€70k–90k', source: 'linkedin',  appliedAt: daysAgo(4) },
    { company: 'Booking.com', logo: 'BK', role: 'Software Engineer',        location: 'Amsterdam, NL', status: 'saved'     as JobStatus, workflowState: 'ready_to_apply' as JobWorkflowState, score: 84, salary: '€65k–85k', source: 'indeed' },
    { company: 'ASML',        logo: 'AS', role: 'Systems Engineer',         location: 'Eindhoven, NL', status: 'applied'   as JobStatus, score: 76, salary: '€60k–80k', source: 'agent',     appliedAt: daysAgo(7) },
    { company: 'Philips',     logo: 'PH', role: 'Data Engineer',            location: 'Amsterdam, NL', status: 'rejected'  as JobStatus, score: 62, salary: '€55k–75k', source: 'linkedin',  appliedAt: daysAgo(11) },
    { company: 'Uber',        logo: 'UB', role: 'SWE Intern',               location: 'Amsterdam, NL', status: 'offer'     as JobStatus, score: 95, salary: '€45k',     source: 'manual',    appliedAt: daysAgo(16) },
    { company: 'Stripe',      logo: 'ST', role: 'Data Infrastructure Eng',  location: 'Dublin, IE',    status: 'applied'   as JobStatus, score: 88, salary: '€75k–95k', source: 'agent',     appliedAt: daysAgo(17) },
    { company: 'Netflix',     logo: 'NF', role: 'Senior Backend Engineer',  location: 'Amsterdam, NL', status: 'saved'     as JobStatus, score: 79, salary: '€90k–120k',source: 'linkedin' },
    { company: 'Cloudflare',  logo: 'CF', role: 'Systems Engineer',         location: 'Remote',        status: 'saved'     as JobStatus, score: 83, salary: '€80k–100k',source: 'agent' },
    { company: 'Mollie',      logo: 'ML', role: 'Backend Engineer',         location: 'Amsterdam, NL', status: 'applied'   as JobStatus, score: 80, salary: '€60k–80k', source: 'indeed',    appliedAt: daysAgo(3) },
    { company: 'Elastic',     logo: 'EL', role: 'Software Engineer II',     location: 'Amsterdam, NL', status: 'saved'     as JobStatus, workflowState: 'ready_to_apply' as JobWorkflowState, score: 85, salary: '€70k–90k', source: 'linkedin' },
  ]

  const jobs = []
  for (const j of jobsData) {
    const job = await db.job.create({
      data: {
        ...j,
        userId: user.id,
        followUpAt: j.appliedAt ? new Date(j.appliedAt.getTime() + 7 * 86400000) : null,
      },
    })
    jobs.push(job)
  }
  console.log(`✓ Jobs: ${jobs.length}`)

  // ── Activities ────────────────────────────────────────────
  const activities = [
    { jobId: jobs[0].id, type: 'applied'             as ActivityType, text: 'Applied to Adyen · Backend Engineer',       color: '#185FA5', createdAt: daysAgo(4) },
    { jobId: jobs[1].id, type: 'interview_scheduled' as ActivityType, text: 'Interview scheduled — Booking.com',         color: '#3B6D11', createdAt: daysAgo(5) },
    { jobId: jobs[2].id, type: 'email_sent'          as ActivityType, text: 'Follow-up email sent — ASML',               color: '#854F0B', createdAt: daysAgo(6) },
    { jobId: jobs[3].id, type: 'rejected'            as ActivityType, text: 'Rejected — Philips · Data Engineer',        color: '#A32D2D', createdAt: daysAgo(11) },
    { jobId: jobs[4].id, type: 'offer_received'      as ActivityType, text: 'Offer received — Uber · SWE Intern 🎉',     color: '#0E7490', createdAt: daysAgo(16) },
    { jobId: jobs[5].id, type: 'resume_tailored'     as ActivityType, text: 'CV tailored for Stripe · Data Infra Eng',  color: '#185FA5', createdAt: daysAgo(17) },
  ]

  for (const a of activities) {
    await db.activity.create({ data: { ...a, userId: user.id } })
  }
  console.log(`✓ Activities: ${activities.length}`)

  // ── Default Resume ─────────────────────────────────────────
  await db.resume.create({
    data: {
      userId: user.id,
      name: 'Main Resume',
      isDefault: true,
      content: {
        contact: {
          name: 'Zhang Li',
          email: 'demo@applymate.ai',
          location: 'Amsterdam, NL',
          linkedin: 'linkedin.com/in/zhang-li',
          github: 'github.com/zhang-li',
        },
        summary: 'Backend engineer with 5+ years building distributed systems at scale. Passionate about developer tooling, observability, and clean APIs.',
        experience: [
          {
            company: 'TechCorp BV',
            role: 'Senior Backend Engineer',
            period: 'Jan 2022 – Present',
            bullets: [
              'Led migration from monolith to microservices, reducing p99 latency by 40%',
              'Built real-time event pipeline handling 50k events/s with Kafka + Flink',
              'Mentored 3 junior engineers; introduced ADR process for architectural decisions',
            ],
          },
          {
            company: 'StartupXYZ',
            role: 'Backend Engineer',
            period: 'Jun 2019 – Dec 2021',
            bullets: [
              'Designed and implemented REST + GraphQL APIs serving 200k MAU',
              'Reduced cloud costs 35% by optimising database queries and caching strategy',
            ],
          },
        ],
        education: [
          { institution: 'TU Delft', degree: 'MSc Computer Science', year: '2019' },
        ],
        skills: ['Python', 'Go', 'TypeScript', 'PostgreSQL', 'Redis', 'Kafka', 'Kubernetes', 'Terraform'],
      },
    },
  })
  console.log('✓ Resume')

  // ── Agent Config ──────────────────────────────────────────
  await db.agentConfig.upsert({
    where: { userId: user.id },
    update: {
      isRunning: true,
      dailyLimit: 10,
      minMatchScore: 75,
      autoApply: false,
      requireApproval: true,
      targetLocations: ['Amsterdam, NL', 'Remote'],
      targetRoles: ['Backend Engineer', 'Software Engineer', 'Systems Engineer'],
      excludeCompanies: [],
      model: 'claude-3-5-sonnet',
    },
    create: {
      userId: user.id,
      isRunning: true,
      dailyLimit: 10,
      minMatchScore: 75,
      autoApply: false,
      requireApproval: true,
      targetLocations: ['Amsterdam, NL', 'Remote'],
      targetRoles: ['Backend Engineer', 'Software Engineer', 'Systems Engineer'],
      excludeCompanies: [],
      model: 'claude-3-5-sonnet',
    },
  })
  console.log('✓ Agent config')

  console.log('\n✅ Seed complete!')
  console.log('   Email:    demo@applymate.ai')
  console.log('   Password: demo1234')
}

function daysAgo(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
