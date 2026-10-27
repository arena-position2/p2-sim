import { MicrosoftIcon } from '@/components/icons'
import { resolveExecutionWorkspaceId } from '@/lib/workspaces/is-admin-workspace'
import type { BlockConfig } from '@/blocks/types'

/** In-flight promise cache keyed by workspaceId — deduplicates concurrent fetchOptions + fetchOptionById calls */
let _inflightFetch: {
  workspaceId: string
  promise: Promise<Record<string, { id: string; name: string }>>
} | null = null

async function fetchBingAdsAccounts(
  workspaceId: string
): Promise<Record<string, { id: string; name: string }>> {
  if (_inflightFetch?.workspaceId === workspaceId) {
    return _inflightFetch.promise
  }

  const promise = fetch(`/api/bing-ads/accounts?workspaceId=${encodeURIComponent(workspaceId)}`)
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

export const BingAdsBlock: BlockConfig = {
  type: 'bing_ads',
  name: 'Bing Ads',
  description: 'Query Microsoft Advertising (Bing Ads) data with natural language',
  longDescription:
    'Connect to Microsoft Advertising (Bing Ads) API and query campaign performance, ad metrics, and account insights using natural language. Supports all Position2 Bing Ads accounts with AI-powered query parsing.',
  docsLink: 'https://docs.sim.ai/blocks/bing-ads',
  category: 'tools',
  bgColor: '#00A4EF',
  icon: MicrosoftIcon,
  subBlocks: [
    {
      id: 'account',
      title: 'Bing Ads Account',
      type: 'dropdown',
      options: [],
      fetchOptions: async () => {
        try {
          const { useWorkflowRegistry } = await import('@/stores/workflows/registry/store')
          const workspaceId = useWorkflowRegistry.getState().hydration.workspaceId
          if (!workspaceId) return []

          const accounts = await fetchBingAdsAccounts(workspaceId)
          return Object.entries(accounts).map(([key, account]) => ({
            id: key,
            label: account.name,
            value: key,
          }))
        } catch {
          return []
        }
      },
      fetchOptionById: async (_blockId: string, optionId: string) => {
        try {
          const { useWorkflowRegistry } = await import('@/stores/workflows/registry/store')
          const workspaceId = useWorkflowRegistry.getState().hydration.workspaceId
          if (!workspaceId) return null

          const accounts = await fetchBingAdsAccounts(workspaceId)
          const account = accounts[optionId]
          if (!account) return null

          return { id: optionId, label: account.name }
        } catch {
          return null
        }
      },
      placeholder: 'Select Bing Ads account...',
      required: true,
      mode: 'basic',
      canonicalParamId: 'account',
    },
    // Bing Ads Account (advanced mode - text input)
    {
      id: 'accountAdvanced',
      title: 'Bing Ads Account',
      type: 'short-input',
      canonicalParamId: 'account',
      placeholder: 'Enter account ID (e.g., 151000820, C000736328)',
      required: true,
      mode: 'advanced',
    },
    {
      id: 'query',
      title: 'Question / Query',
      type: 'long-input',
      placeholder:
        'Ask any question about Bing Ads data, e.g., "Show me campaign performance for last 30 days", "What are my top spending campaigns this month?", "How many conversions did I get last week?"',
      rows: 3,
      required: true,
      wandConfig: {
        enabled: true,
        prompt: `You are a Bing Ads (Microsoft Advertising) query assistant. Help users create effective questions for Bing Ads data analysis.

### EXAMPLES OF GOOD QUESTIONS
- "Show me campaign performance for last 30 days"
- "What are my top spending campaigns this month?"
- "How many conversions did I get last week?"
- "Which campaigns have the highest CTR?"
- "Show me cost analysis for the last 15 days"
- "What's my impression share for active campaigns?"
- "Compare this month vs last month performance"
- "Show me keyword performance data"

### AVAILABLE METRICS
- Clicks, Impressions, Spend, Conversions
- CTR (Click-through rate), CPC (Cost per click)
- Conversion rate, Cost per conversion
- Impression share, Average position
- ROAS (Return on ad spend)

### TIME PERIODS
- Last 7/15/30 days
- This/Last month, This/Last week
- Yesterday, Today
- Specific date ranges

Generate a clear, specific question about Bing Ads performance based on the user's request.`,
      },
    },
  ],
  tools: {
    access: ['bing_ads_query'],
    config: {
      tool: () => 'bing_ads_query',
      params: (params) => ({
        account: params.accountAdvanced ?? params.account,
        query: params.query,
        workspaceId: resolveExecutionWorkspaceId(params as Record<string, unknown> | undefined),
        _context: params._context,
      }),
    },
  },
  inputs: {
    account: { type: 'string', description: 'Bing Ads account identifier' },
    query: { type: 'string', description: 'Natural language query from user chat' },
  },
  outputs: {
    data: {
      type: 'json',
      description: 'Bing Ads performance data',
    },
    account_id: {
      type: 'string',
      description: 'Bing Ads account ID',
    },
    account_name: {
      type: 'string',
      description: 'Bing Ads account name',
    },
    query: {
      type: 'string',
      description: 'Original query',
    },
  },
}
