import type { MetadataRoute } from 'next'
import { getEnv } from '@/lib/core/config/env'
import { isSearchIndexableAppUrl, SITE_URL } from '@/lib/core/utils/urls'

/**
 * Only `/api/` is blocked from crawling. App and utility surfaces stay
 * crawlable so search engines can see the `X-Robots-Tag: noindex` the proxy
 * sends on them (a disallowed URL can still be indexed from external links),
 * and `/_next/` stays crawlable so pages render with their scripts, styles,
 * and images.
 */
export default function robots(): MetadataRoute.Robots {
  // Dev / test / sandbox share the same image; only prod agent may be crawled.
  if (!isSearchIndexableAppUrl(getEnv('NEXT_PUBLIC_APP_URL'))) {
    return {
      rules: { userAgent: '*', disallow: '/' },
    }
  }

  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/'] },
    sitemap: [
      `${SITE_URL}/sitemap.xml`,
      `${SITE_URL}/blog/sitemap-images.xml`,
      `${SITE_URL}/library/sitemap-images.xml`,
    ],
  }
}
