import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { Providers } from '@/components/Providers'
import { getUsageAnalyticsConsent } from '@/lib/usage-analytics'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'ApplyMate AI – Job Copilot',
  description: 'AI-powered job application automation for European job seekers',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const usageAnalyticsAllowed = await getUsageAnalyticsConsent()

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className} suppressHydrationWarning>
        <Providers>{children}</Providers>
        {usageAnalyticsAllowed && <SpeedInsights />}
      </body>
    </html>
  )
}
