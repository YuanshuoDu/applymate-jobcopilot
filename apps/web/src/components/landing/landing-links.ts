import { authLink } from '@/lib/auth-callback'

export type LandingLink = {
  label: string
  href: string
  external?: boolean
}

export type LandingFeaturePage = 'resume' | 'jobs' | 'gmail' | 'agent' | 'search'

export function landingFeatureHref(page: LandingFeaturePage): string {
  return authLink('/register', `/?page=${page}`)
}

export type LandingPlanAction = { href: '/register' | '#contact'; message?: string }

export function landingPlanAction(key: string): LandingPlanAction {
  if (key === 'pro') return { href: '#contact', message: 'I would like to start the Pro free trial.' }
  if (key === 'enterprise') return { href: '#contact', message: 'I would like to discuss a Team plan for my organisation.' }
  return { href: '/register' }
}

export const SOCIAL_LINKS: LandingLink[] = [
  { label: 'GitHub', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot', external: true },
  { label: 'Support', href: 'mailto:hello@applymate.ai?subject=ApplyMate%20support' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/applymate-ai/', external: true },
]

export const FOOTER_COLUMNS: Array<{ title: string; links: LandingLink[] }> = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '#features' },
      { label: 'Pricing', href: '#pricing' },
      { label: 'Chrome Extension', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot/tree/main/apps/extension', external: true },
      { label: 'Changelog', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot/releases', external: true },
      { label: 'API', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot', external: true },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: 'mailto:hello@applymate.ai?subject=About%20ApplyMate' },
      { label: 'Blog', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot/discussions', external: true },
      { label: 'Careers', href: 'mailto:hello@applymate.ai?subject=Careers%20at%20ApplyMate' },
      { label: 'Press', href: 'mailto:hello@applymate.ai?subject=Press%20inquiry' },
    ],
  },
  {
    title: 'Support',
    links: [
      { label: 'Help centre', href: 'mailto:hello@applymate.ai?subject=Help%20request' },
      { label: 'Contact', href: '#contact' },
      { label: 'Status', href: 'mailto:hello@applymate.ai?subject=Status%20question' },
      { label: 'Security', href: 'mailto:security@applymate.ai?subject=Security%20question' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy policy', href: 'mailto:legal@applymate.ai?subject=Privacy%20policy' },
      { label: 'Terms of service', href: 'mailto:legal@applymate.ai?subject=Terms%20of%20service' },
      { label: 'Cookie settings', href: 'mailto:legal@applymate.ai?subject=Cookie%20settings' },
      { label: 'GDPR', href: 'mailto:legal@applymate.ai?subject=GDPR%20request' },
    ],
  },
]
