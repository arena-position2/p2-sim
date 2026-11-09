import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { slackTokenContract, slackTokenFormSchema } from '@/lib/api/contracts/arena-auth'
import { env } from '@/lib/core/config/env'

const logger = createLogger('SlackTokenProxy')

export const dynamic = 'force-dynamic'

/**
 * Proxy route for Slack's `oauth.v2.access` token exchange.
 *
 * Better Auth's `getOAuth2Tokens` only maps `id_token` from the token response.
 * Slack returns the user token as `authed_user.access_token` (not `id_token`), so
 * it would otherwise be discarded. This proxy injects it as `id_token` before
 * returning the response, so Better Auth stores it in `account.idToken`.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.formData()
    const codeField = body.get('code')
    const redirectField = body.get('redirect_uri')
    const slackTokenBodySchema = slackTokenContract.body ?? slackTokenFormSchema
    const parsed = slackTokenBodySchema.safeParse({
      code: typeof codeField === 'string' ? codeField : undefined,
      redirect_uri: typeof redirectField === 'string' ? redirectField : undefined,
    })
    if (!parsed.success) {
      logger.error('Slack token proxy: missing code in request')
      return NextResponse.json({ ok: false, error: 'missing_code' }, { status: 400 })
    }
    const { code, redirect_uri: redirectUri } = parsed.data

    const clientId = env.SLACK_CLIENT_ID?.trim().replace(/^["']|["']$/g, '')
    const clientSecret = env.SLACK_CLIENT_SECRET?.trim().replace(/^["']|["']$/g, '')

    if (!clientId || !clientSecret) {
      logger.error('Slack token proxy: credentials not configured')
      return NextResponse.json({ ok: false, error: 'config_error' }, { status: 500 })
    }

    logger.info('Slack token proxy: exchanging code', {
      hasCode: !!code,
      hasRedirectUri: !!redirectUri,
    })

    const params: Record<string, string> = {
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }
    if (redirectUri) {
      params.redirect_uri = redirectUri
    }

    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      logger.error('Slack token proxy: upstream request failed', {
        status: tokenResponse.status,
        body: errorText,
      })
      return NextResponse.json({ ok: false, error: 'upstream_error' }, { status: 502 })
    }

    const tokenData = await tokenResponse.json()

    if (!tokenData.ok) {
      logger.error('Slack token proxy: token exchange error', { error: tokenData.error })
      return NextResponse.json(tokenData, { status: 400 })
    }

    const userToken = tokenData.authed_user?.access_token ?? null

    logger.info('Slack token proxy: exchange successful', {
      hasBotToken: !!tokenData.access_token,
      hasUserToken: !!userToken,
    })

    return NextResponse.json({
      ...tokenData,
      id_token: userToken,
    })
  } catch (error) {
    logger.error('Slack token proxy: unexpected error', { error })
    return NextResponse.json({ ok: false, error: 'proxy_error' }, { status: 500 })
  }
}
