import { MetaIcon } from '@/components/icons'
import { getScopesForService } from '@/lib/oauth/utils'
import {
  isAdminWorkspace,
  resolveExecutionWorkspaceId,
  resolveWorkspaceIdForAdminCheck,
} from '@/lib/workspaces/is-admin-workspace'
import type { BlockConfig, BlockMeta } from '@/blocks/types'
import { AuthMode, IntegrationType } from '@/blocks/types'

const FACEBOOK_ADS_COND_NEVER = '__facebook_ads_cond_never__'

/** In-flight promise cache keyed by workspaceId — deduplicates concurrent fetchOptions + fetchOptionById calls */
let _inflightFetch: {
  workspaceId: string
  promise: Promise<Record<string, { id: string; name: string }>>
} | null = null

async function fetchFacebookAdsAccounts(
  workspaceId: string
): Promise<Record<string, { id: string; name: string }>> {
  if (_inflightFetch?.workspaceId === workspaceId) {
    return _inflightFetch.promise
  }

  const promise = fetch(`/api/facebook-ads/accounts?workspaceId=${encodeURIComponent(workspaceId)}`)
    .then((r) => r.json())
    .then((data) => {
      _inflightFetch = null
      if (data?.success && data.accounts && typeof data.accounts === 'object') {
        return data.accounts as Record<string, { id: string; name: string }>
      }
      return {}
    })
    .catch(() => {
      _inflightFetch = null
      return {}
    })

  _inflightFetch = { workspaceId, promise }
  return promise
}

/** Show admin account dropdown fields (admin workspaces only). */
function facebookAdsAdminOnlyCondition(values?: Record<string, unknown>) {
  const isAdmin = isAdminWorkspace(resolveWorkspaceIdForAdminCheck(values))
  if (isAdmin) {
    return { field: 'query', value: FACEBOOK_ADS_COND_NEVER, not: true as const }
  }
  return { field: 'query', value: FACEBOOK_ADS_COND_NEVER }
}

/** Show Facebook OAuth and ad account ID fields (non-admin workspaces only). */
function facebookAdsNonAdminOnlyCondition(values?: Record<string, unknown>) {
  const isAdmin = isAdminWorkspace(resolveWorkspaceIdForAdminCheck(values))
  if (isAdmin) {
    return { field: 'query', value: FACEBOOK_ADS_COND_NEVER }
  }
  return { field: 'query', value: FACEBOOK_ADS_COND_NEVER, not: true as const }
}

export const FacebookAdsBlock: BlockConfig = {
  type: 'facebook_ads',
  name: 'Facebook Ads',
  description: 'Query Facebook Ads data with natural language',
  longDescription:
    'Connect to Facebook Ads API and query campaign performance, ad set metrics, and account insights using natural language. Supports all 22 Position2 Facebook ad accounts with AI-powered query parsing.',
  docsLink: 'https://docs.sim.ai/blocks/facebook-ads',
  category: 'tools',
  integrationType: IntegrationType.Marketing,
  authMode: AuthMode.OAuth,
  bgColor: '#1877F2',
  icon: MetaIcon,
  subBlocks: [
    {
      id: 'credential',
      title: 'Facebook Ads Account',
      type: 'oauth-input',
      canonicalParamId: 'oauthCredential',
      mode: 'basic',
      serviceId: 'facebook-ads',
      requiredScopes: getScopesForService('facebook-ads'),
      placeholder: 'Connect Facebook Ads account',
      required: true,
      condition: facebookAdsNonAdminOnlyCondition,
    },
    {
      id: 'manualCredential',
      title: 'Facebook Ads Account',
      type: 'short-input',
      canonicalParamId: 'oauthCredential',
      mode: 'advanced',
      placeholder: 'Enter credential ID',
      required: true,
      condition: facebookAdsNonAdminOnlyCondition,
    },
    {
      id: 'accountId',
      title: 'Ad Account ID',
      type: 'short-input',
      canonicalParamId: 'adAccountId',
      placeholder: 'Ad account ID (e.g. act_123456789)',
      required: true,
      condition: facebookAdsNonAdminOnlyCondition,
    },
    {
      id: 'accountSelector',
      title: 'Facebook Ad Account',
      type: 'dropdown',
      options: [],
      fetchOptions: async () => {
        try {
          const { useWorkflowRegistry } = await import('@/stores/workflows/registry/store')
          const workspaceId = useWorkflowRegistry.getState().hydration.workspaceId
          if (!workspaceId) return []

          const accounts = await fetchFacebookAdsAccounts(workspaceId)
          return Object.entries(accounts)
            .map(([key, account]) => ({
              id: key,
              label: account.name,
              value: key,
            }))
            .sort((a, b) => a.label.localeCompare(b.label))
        } catch {
          return []
        }
      },
      fetchOptionById: async (_blockId: string, optionId: string) => {
        try {
          const { useWorkflowRegistry } = await import('@/stores/workflows/registry/store')
          const workspaceId = useWorkflowRegistry.getState().hydration.workspaceId
          if (!workspaceId) return null

          const accounts = await fetchFacebookAdsAccounts(workspaceId)
          const account = accounts[optionId]
          if (!account) return null

          return { id: optionId, label: account.name }
        } catch {
          return null
        }
      },
      placeholder: 'Select Facebook ad account',
      required: true,
      mode: 'basic',
      canonicalParamId: 'account',
      condition: facebookAdsAdminOnlyCondition,
    },
    {
      id: 'accountAdvanced',
      title: 'Facebook Ad Account',
      type: 'short-input',
      canonicalParamId: 'account',
      placeholder: 'Enter account key (e.g., ami, holm)',
      required: true,
      mode: 'advanced',
      condition: facebookAdsAdminOnlyCondition,
    },
    {
      id: 'query',
      title: 'Question / Query',
      type: 'long-input',
      placeholder: '<start.input>',
      description: 'Connect user input from Start block - user will chat with Agent',
      required: true,
    },
  ],
  tools: {
    access: ['facebook_ads_query'],
    config: {
      tool: () => 'facebook_ads_query',
      params: (params) => {
        const workspaceId = resolveExecutionWorkspaceId(
          params as Record<string, unknown> | undefined
        )
        const oauthCredential = (params.oauthCredential ??
          params.credential ??
          params.manualCredential) as string | undefined
        // Model- or dropdown-filled catalog key. Carried on BOTH paths (like
        // bing_ads) so an agent-filled account is never dropped: the query
        // route routes to the workspace catalog whenever `account` is set and
        // no user OAuth credentials are provided.
        const account = params.accountAdvanced ?? params.accountSelector ?? params.account

        if (isAdminWorkspace(workspaceId)) {
          return {
            account,
            query: params.query,
            workspaceId,
            _context: params._context,
          }
        }

        return {
          account,
          query: params.query,
          workspaceId,
          oauthCredential,
          adAccountId: params.accountId ?? params.adAccountId,
          _context: params._context,
        }
      },
    },
  },
  inputs: {
    account: {
      type: 'string',
      description: 'Facebook ad account identifier (admin workspaces)',
    },
    query: {
      type: 'string',
      description: 'Natural language query from user chat',
    },
    oauthCredential: { type: 'string', description: 'Facebook Ads OAuth credential' },
    accountId: { type: 'string', description: 'Facebook ad account ID (act_...)' },
    adAccountId: { type: 'string', description: 'Facebook ad account ID (act_...)' },
  },
  outputs: {
    data: {
      type: 'json',
      description: 'Facebook Ads performance data',
    },
    account_id: {
      type: 'string',
      description: 'Facebook ad account ID',
    },
    account_name: {
      type: 'string',
      description: 'Facebook ad account name',
    },
    query: {
      type: 'string',
      description: 'Original query',
    },
  },
}

export const FacebookAdsBlockMeta = {
  tags: ['marketing', 'data-analytics'],
  url: 'https://www.facebook.com/business/ads',
} as const satisfies BlockMeta
