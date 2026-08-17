import { authLink } from '@/lib/auth-callback'

export type LandingLink = {
  labelKey: string
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
  { labelKey: 'landing.footer.github', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot', external: true },
  { labelKey: 'landing.footer.support', href: 'mailto:hello@applymate.ai?subject=ApplyMate%20support' },
  { labelKey: 'landing.footer.linkedin', href: 'https://www.linkedin.com/company/applymate-ai/', external: true },
]

export const FOOTER_COLUMNS: Array<{ titleKey: string; links: LandingLink[] }> = [
  {
    titleKey: 'landing.footer.product',
    links: [
      { labelKey: 'landing.features', href: '#features' },
      { labelKey: 'landing.pricing', href: '#pricing' },
      { labelKey: 'landing.footer.extension', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot/tree/main/apps/extension', external: true },
      { labelKey: 'landing.footer.changelog', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot/releases', external: true },
      { labelKey: 'landing.footer.api', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot', external: true },
    ],
  },
  {
    titleKey: 'landing.footer.company',
    links: [
      { labelKey: 'landing.footer.about', href: 'mailto:hello@applymate.ai?subject=About%20ApplyMate' },
      { labelKey: 'landing.footer.blog', href: 'https://github.com/YuanshuoDu/applymate-jobcopilot/discussions', external: true },
      { labelKey: 'landing.footer.careers', href: 'mailto:hello@applymate.ai?subject=Careers%20at%20ApplyMate' },
      { labelKey: 'landing.footer.press', href: 'mailto:hello@applymate.ai?subject=Press%20inquiry' },
    ],
  },
  {
    titleKey: 'landing.footer.supportTitle',
    links: [
      { labelKey: 'landing.footer.help', href: 'mailto:hello@applymate.ai?subject=Help%20request' },
      { labelKey: 'landing.contact', href: '#contact' },
      { labelKey: 'landing.footer.status', href: 'mailto:hello@applymate.ai?subject=Status%20question' },
      { labelKey: 'landing.footer.security', href: 'mailto:security@applymate.ai?subject=Security%20question' },
    ],
  },
  {
    titleKey: 'landing.footer.legal',
    links: [
      { labelKey: 'landing.footer.privacy', href: 'mailto:legal@applymate.ai?subject=Privacy%20policy' },
      { labelKey: 'landing.footer.terms', href: 'mailto:legal@applymate.ai?subject=Terms%20of%20service' },
      { labelKey: 'landing.footer.cookies', href: 'mailto:legal@applymate.ai?subject=Cookie%20settings' },
      { labelKey: 'landing.footer.gdpr', href: 'mailto:legal@applymate.ai?subject=GDPR%20request' },
    ],
  },
]
