import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { sleep } from '@sim/utils/helpers'
import { GOOGLE_ADS_API_VERSION, POSITION2_MANAGER } from './constants'

const logger = createLogger('GoogleAdsAPI')

const GOOGLE_ADS_RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const

/**
 * Returns true when the Google Ads API response indicates a developer quota rate limit.
 */
function isGoogleAdsRateLimitError(status: number, errorText: string): boolean {
  if (status !== 429) return false

  try {
    const data = JSON.parse(errorText) as {
      error?: { status?: string; code?: number }
    }
    return data.error?.status === 'RESOURCE_EXHAUSTED' || data.error?.code === 429
  } catch {
    return false
  }
}

/**
 * Executes a Google Ads search request with exponential backoff on RESOURCE_EXHAUSTED errors.
 */
async function fetchGoogleAdsSearchWithRetry(
  adsApiUrl: string,
  requestInit: RequestInit,
  customerId: string
): Promise<Response> {
  const maxAttempts = GOOGLE_ADS_RATE_LIMIT_RETRY_DELAYS_MS.length + 1

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const adsResponse = await fetch(adsApiUrl, requestInit)

    if (adsResponse.ok) {
      return adsResponse
    }

    const errorText = await adsResponse.text()
    const isLastAttempt = attempt === maxAttempts - 1
    const shouldRetry = isGoogleAdsRateLimitError(adsResponse.status, errorText) && !isLastAttempt

    if (!shouldRetry) {
      logger.error('Google Ads API request failed', {
        status: adsResponse.status,
        error: errorText,
        customerId,
        managerCustomerId: POSITION2_MANAGER,
        attempt: attempt + 1,
      })
      throw new Error(`Google Ads API request failed: ${adsResponse.status} - ${errorText}`)
    }

    const delayMs = GOOGLE_ADS_RATE_LIMIT_RETRY_DELAYS_MS[attempt]
    logger.warn('Google Ads API rate limited, retrying', {
      customerId,
      attempt: attempt + 1,
      maxAttempts,
      delayMs,
    })
    await sleep(delayMs)
  }

  throw new Error('Google Ads API request failed after retries')
}

/**
 * Makes a request to the Google Ads API using GAQL query
 */
export async function makeGoogleAdsRequest(accountId: string, gaqlQuery: string): Promise<any> {
  logger.info('Making real Google Ads API request', { accountId, gaqlQuery })

  try {
    // Get Google Ads API credentials from environment variables
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET
    const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN

    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new Error(
        'Missing Google Ads API credentials. Please set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_REFRESH_TOKEN environment variables.'
      )
    }

    logger.info('Using Google Ads credentials', {
      developerToken: `${developerToken.substring(0, 10)}...`,
      clientId: `${clientId.substring(0, 30)}...`,
      clientIdFull: clientId, // Log full client ID for debugging
      hasClientSecret: !!clientSecret,
      hasRefreshToken: !!refreshToken,
      clientSecretLength: clientSecret.length,
      refreshTokenLength: refreshToken.length,
    })

    // Prepare token request body
    const tokenRequestBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })

    logger.info('Token request details', {
      url: 'https://oauth2.googleapis.com/token',
      bodyParams: {
        client_id: clientId,
        grant_type: 'refresh_token',
        hasClientSecret: !!clientSecret,
        hasRefreshToken: !!refreshToken,
      },
    })

    // Get access token using refresh token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenRequestBody,
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      logger.error('Token refresh failed', {
        status: tokenResponse.status,
        error: errorText,
        clientId: `${clientId.substring(0, 20)}...`,
      })
      throw new Error(
        `Failed to refresh Google Ads access token: ${tokenResponse.status} - ${errorText}`
      )
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token

    logger.info('Successfully obtained access token')

    // Format customer ID (remove dashes if present)
    const formattedCustomerId = accountId.replace(/-/g, '')

    // Make Google Ads API request
    const adsApiUrl = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${formattedCustomerId}/googleAds:search`

    const requestPayload = {
      query: gaqlQuery.trim(),
    }

    logger.info('Making Google Ads API request', {
      url: adsApiUrl,
      customerId: formattedCustomerId,
      query: gaqlQuery.trim(),
      managerCustomerId: POSITION2_MANAGER,
    })

    const adsResponse = await fetchGoogleAdsSearchWithRetry(
      adsApiUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'login-customer-id': POSITION2_MANAGER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestPayload),
      },
      formattedCustomerId
    )

    const adsData = await adsResponse.json()
    logger.info('Google Ads API request successful', {
      resultsCount: adsData.results?.length || 0,
      customerId: formattedCustomerId,
      responseKeys: Object.keys(adsData),
      hasResults: !!adsData.results,
      firstResultKeys: adsData.results?.[0] ? Object.keys(adsData.results[0]) : [],
    })

    // Log a sample of the response structure for debugging
    if (adsData.results?.[0]) {
      logger.debug('Sample Google Ads API response structure', {
        sampleResult: {
          keys: Object.keys(adsData.results[0]),
          campaign: adsData.results[0].campaign ? Object.keys(adsData.results[0].campaign) : null,
          metrics: adsData.results[0].metrics ? Object.keys(adsData.results[0].metrics) : null,
          segments: adsData.results[0].segments ? Object.keys(adsData.results[0].segments) : null,
        },
      })
    }

    return adsData
  } catch (error) {
    logger.error('Error in Google Ads API request', {
      error: toError(error).message,
      accountId,
    })
    throw error
  }
}
