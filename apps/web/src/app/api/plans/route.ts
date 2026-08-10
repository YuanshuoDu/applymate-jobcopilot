import { getPublicPlans } from '@/lib/plan-catalogue'

export async function GET() {
  const response = Response.json({ plans: await getPublicPlans() })
  response.headers.set('Cache-Control', 'no-store')
  return response
}
