'use client'

import type { ReactNode } from 'react'
import { TrackingConsentProvider } from '@/lib/consent/tracking-consent'
import { AttributionCookieGuard } from '@/app/_shell/consent/attribution-cookie-guard'
import { ConsentStoreProvider } from '@/app/_shell/consent/consent-store-provider'
import { FreebuffClickIdGuard } from '@/app/_shell/consent/freebuff-click-id-guard'
import { GoogleAnalyticsPageViewTracker } from '@/app/_shell/consent/google-analytics-page-view-tracker'

interface ConsentProviderProps {
  children: ReactNode
}

/**
 * Owns hosted Sim's consent lifecycle across every route.
 *
 * The cookie banner is commented off until Arena legal/cookie policy is
 * finalized. Restore `ConsentBanner` after that review.
 */
export function ConsentProvider({ children }: ConsentProviderProps) {
  return (
    <ConsentStoreProvider>
      <TrackingConsentProvider>
        {children}
        <GoogleAnalyticsPageViewTracker />
        <FreebuffClickIdGuard />
        <AttributionCookieGuard />
      </TrackingConsentProvider>
    </ConsentStoreProvider>
  )
}
