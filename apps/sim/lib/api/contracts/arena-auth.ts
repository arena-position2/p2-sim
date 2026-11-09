import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const cookieClearedResponse = z.object({
  ok: z.literal(true),
  cleared: z.literal('host-only-better-auth-session-cookies'),
})

const domainCookieClearedResponse = z.object({
  ok: z.literal(true),
  hostnamesCleared: z.union([
    z.object({
      fromNextPublicAppUrl: z.string(),
      includeParentDomain: z.boolean(),
    }),
    z.object({ mode: z.literal('host-only') }),
  ]),
})

export const clearLegacySessionCookiesGetContract = defineRouteContract({
  method: 'GET',
  path: '/api/auth/clear-legacy-session-cookies',
  response: { mode: 'json', schema: cookieClearedResponse },
})

export const clearLegacySessionCookiesPostContract = defineRouteContract({
  method: 'POST',
  path: '/api/auth/clear-legacy-session-cookies',
  response: { mode: 'json', schema: cookieClearedResponse },
})

export const clearDomainSessionCookiesGetContract = defineRouteContract({
  method: 'GET',
  path: '/api/auth/clear-domain-session-cookies',
  response: { mode: 'json', schema: domainCookieClearedResponse },
})

export const clearDomainSessionCookiesPostContract = defineRouteContract({
  method: 'POST',
  path: '/api/auth/clear-domain-session-cookies',
  response: { mode: 'json', schema: domainCookieClearedResponse },
})

export const hubspotCampaignsContract = defineRouteContract({
  method: 'GET',
  path: '/api/auth/oauth/hubspot/campaigns',
  query: z.object({
    credentialId: requiredFieldSchema('Credential ID is required'),
    limit: z.string().optional(),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      campaigns: z.array(z.record(z.string(), z.unknown())),
    }),
  },
})

export const unipileHostedNotifyContract = defineRouteContract({
  method: 'POST',
  path: '/api/auth/unipile/hosted/notify',
  body: z.unknown(),
  response: {
    mode: 'json',
    schema: z.object({
      received: z.literal(true),
      persisted: z.boolean(),
    }),
  },
})

export const slackTokenFormSchema = z.object({
  code: requiredFieldSchema('missing_code'),
  redirect_uri: z.string().optional(),
})

export const slackTokenContract = defineRouteContract({
  method: 'POST',
  path: '/api/auth/oauth2/slack/token',
  body: slackTokenFormSchema,
  response: {
    mode: 'json',
    // untyped-response: Slack oauth.v2.access JSON is returned with id_token added
    schema: z.record(z.string(), z.unknown()),
  },
})
