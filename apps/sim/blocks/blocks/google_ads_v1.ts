import { GoogleIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'

/** In-flight promise cache keyed by workspaceId — deduplicates concurrent fetchOptions + fetchOptionById calls */
let _inflightFetch: {
  workspaceId: string
  promise: Promise<Record<string, { id: string; name: string }>>
} | null = null

async function fetchGoogleAdsAccounts(
  workspaceId: string
): Promise<Record<string, { id: string; name: string }>> {
  if (_inflightFetch?.workspaceId === workspaceId) {
    return _inflightFetch.promise
  }

  const promise = fetch(`/api/google-ads/accounts?workspaceId=${encodeURIComponent(workspaceId)}`)
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

export const GoogleAdsV1Block: BlockConfig = {
  type: 'google_ads_v1',
  name: 'Google Ads V1',
  description: 'AI-powered Google Ads query tool with simplified GAQL generation',
  longDescription:
    'Simplified Google Ads block that uses AI (Grok with GPT-4o fallback) to automatically generate GAQL queries from natural language prompts. Perfect for quick queries without complex configuration. Supports campaign performance, keyword analysis, search terms, and more.',
  docsLink: 'https://docs.sim.ai/tools/google-ads-v1',
  category: 'tools',
  bgColor: '#4285f4',
  icon: GoogleIcon,
  subBlocks: [
    {
      id: 'accountsSelector',
      title: 'Google Ads Account',
      type: 'dropdown',
      options: [],
      fetchOptions: async () => {
        try {
          const { useWorkflowRegistry } = await import('@/stores/workflows/registry/store')
          const workspaceId = useWorkflowRegistry.getState().hydration.workspaceId
          if (!workspaceId) return []

          const accounts = await fetchGoogleAdsAccounts(workspaceId)
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

          const accounts = await fetchGoogleAdsAccounts(workspaceId)
          const account = accounts[optionId]
          if (!account) return null

          return { id: optionId, label: account.name }
        } catch {
          return null
        }
      },
      placeholder: 'Select account...',
      required: true,
      mode: 'basic',
      canonicalParamId: 'accounts',
    },
    {
      id: 'accountsAdvanced',
      title: 'Google Ads Account',
      type: 'short-input',
      canonicalParamId: 'accounts',
      placeholder: 'Enter account key or numeric account ID',
      required: true,
      mode: 'advanced',
    },
    {
      id: 'prompt',
      title: 'Natural Language Query',
      type: 'long-input',
      placeholder:
        'Describe what data you want in plain English, e.g., "show campaign performance for the last 30 days", "keywords with quality score below 5", "search terms this week ordered by cost"',
      rows: 3,
      required: true,
      wandConfig: {
        enabled: true,
        prompt: `You are a Google Ads V1 query assistant. Help users create effective natural language prompts for Google Ads data.

### EXAMPLES OF GOOD PROMPTS
- "show campaign performance for the last 30 days"
- "keywords with quality score below 5"
- "search terms this week ordered by cost"
- "campaigns that spent more than $100 last week"
- "ad groups in Brand campaign"
- "RSA ads with poor ad strength"
- "geographic performance by state"
- "top 20 keywords by conversions"

### AVAILABLE DATA
**Resources (Tables):**
- campaign: Campaign performance data
- ad_group: Ad group information
- keyword_view: Keywords with quality scores
- ad_group_ad: Ad-level data (RSA ads)
- campaign_search_term_view: Search query reports
- geographic_view: Location performance
- campaign_asset: Extensions/sitelinks

**Metrics:**
- impressions, clicks, cost
- conversions, conversion value
- CTR, average CPC
- quality score (keywords only)

**Date Ranges:**
- last 7/30/90 days
- this week, last week
- this month, last month
- yesterday, today

### HOW IT WORKS
The AI will automatically:
1. Generate a valid GAQL query from your prompt
2. Handle all date filtering logic
3. Add proper filters (e.g., only active campaigns)
4. Execute the query and return results

Generate a clear, specific prompt for what the user wants to query from Google Ads.`,
      },
    },
  ],
  tools: {
    access: ['google_ads_v1_query'],
    config: {
      tool: () => 'google_ads_v1_query',
      params: (params) => ({
        accounts: params.accountsAdvanced ?? params.accountsSelector ?? params.accounts,
        prompt: params.prompt,
      }),
    },
  },
  inputs: {
    prompt: {
      type: 'string',
      description: 'Natural language description of what data you want',
    },
    accounts: {
      type: 'string',
      description: 'Google Ads account key or numeric account ID',
    },
  },
  outputs: {
    success: { type: 'boolean', description: 'Whether the query succeeded' },
    query: { type: 'string', description: 'Original natural language query' },
    gaql_query: { type: 'string', description: 'Generated GAQL query' },
    query_type: { type: 'string', description: 'Type of query (campaigns, keywords, etc.)' },
    tables_used: { type: 'json', description: 'List of tables used in the query' },
    metrics_used: { type: 'json', description: 'List of metrics used in the query' },
    results: { type: 'json', description: 'Query results with campaigns and totals' },
    account: { type: 'json', description: 'Account information (id, name)' },
    execution_time_ms: { type: 'number', description: 'Query execution time in milliseconds' },
  },
}
