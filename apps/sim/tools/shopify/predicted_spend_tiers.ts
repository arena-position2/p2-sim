import type { ToolConfig } from '@/tools/types'

interface SpendTier {
  tier: string
  customerCount: number
  totalRevenue: number
  averageOrderValue: number
  averageOrderCount: number
}

export interface ShopifyPredictedSpendTiersParams {
  shopDomain: string
  accessToken: string
  idToken?: string
  startDate?: string
  endDate?: string
}

export interface ShopifyPredictedSpendTiersResponse {
  success: boolean
  error?: string
  output: {
    tiers: SpendTier[]
    summary: {
      totalCustomers: number
      highSpendCustomers: number
      mediumSpendCustomers: number
      lowSpendCustomers: number
      averageCustomerSpend: number
      currency: string
    }
  }
}

export const shopifyPredictedSpendTiersTool: ToolConfig<
  ShopifyPredictedSpendTiersParams,
  ShopifyPredictedSpendTiersResponse
> = {
  id: 'shopify_predicted_spend_tiers',
  name: 'Shopify Predicted Spend Tiers',
  description:
    'Segment customers into spend tiers (high/medium/low) based on their purchase history',
  version: '1.0.0',

  oauth: {
    required: true,
    provider: 'shopify',
  },

  params: {
    shopDomain: {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description: 'Your Shopify store domain (e.g., mystore.myshopify.com)',
    },
    startDate: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Start date (format: YYYY-MM-DD)',
    },
    endDate: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'End date (format: YYYY-MM-DD)',
    },
  },

  request: {
    url: (params) =>
      `https://${params.shopDomain || params.idToken}/admin/api/2024-10/graphql.json`,
    method: 'POST',
    headers: (params) => {
      if (!params.accessToken) {
        throw new Error('Missing access token for Shopify API request')
      }
      return {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': params.accessToken,
      }
    },
    body: (params) => {
      let dateQuery = ''
      if (params.startDate || params.endDate) {
        const dateParts: string[] = []
        if (params.startDate) dateParts.push(`created_at:>=${params.startDate}`)
        if (params.endDate) dateParts.push(`created_at:<=${params.endDate}`)
        dateQuery = dateParts.join(' ')
      }

      return {
        query: `
          query getOrdersForSpendTiers($first: Int!, $query: String) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  totalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  customer {
                    id
                  }
                  test
                }
              }
            }
          }
        `,
        variables: {
          first: 250,
          query: dateQuery || null,
        },
      }
    },
  },

  transformResponse: async (_response, params) => {
    let allOrders: any[] = []

    function buildDateQuery(p: any) {
      let dateQuery = ''
      if (p.startDate || p.endDate) {
        const dateParts: string[] = []
        if (p.startDate) dateParts.push(`created_at:>=${p.startDate}`)
        if (p.endDate) dateParts.push(`created_at:<=${p.endDate}`)
        dateQuery = dateParts.join(' ')
      }
      return dateQuery || null
    }

    const fetchAllOrders = async (currentCursor: string | null) => {
      if (!params) throw new Error('Missing parameters for Shopify API request')
      const res = await fetch(
        `https://${params.shopDomain || params.idToken}/admin/api/2024-10/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': params.accessToken,
          },
          body: JSON.stringify({
            query: `
              query getOrdersForSpendTiers($first: Int!, $query: String, $after: String) {
                orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      id
                      totalPriceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                      customer {
                        id
                      }
                      test
                    }
                    cursor
                  }
                  pageInfo {
                    hasNextPage
                  }
                }
              }
            `,
            variables: {
              first: 250,
              query: buildDateQuery(params),
              after: currentCursor,
            },
          }),
        }
      )

      const data = await res.json()
      if (data.errors) throw new Error(data.errors[0]?.message || 'Failed to fetch orders')

      const ordersData = data.data?.orders
      if (!ordersData) return

      allOrders = [...allOrders, ...ordersData.edges.map((edge: any) => edge.node)]

      if (ordersData.pageInfo.hasNextPage) {
        const lastCursor = ordersData.edges[ordersData.edges.length - 1].cursor
        await fetchAllOrders(lastCursor)
      }
    }

    try {
      await fetchAllOrders(null)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch orders',
        output: {
          tiers: [],
          summary: {
            totalCustomers: 0,
            highSpendCustomers: 0,
            mediumSpendCustomers: 0,
            lowSpendCustomers: 0,
            averageCustomerSpend: 0,
            currency: 'USD',
          },
        },
      }
    }

    const customerSpendMap = new Map<string, { totalSpent: number; orderCount: number }>()

    for (const order of allOrders) {
      if (order.test || !order.customer?.id) continue
      const customerId = order.customer.id
      const amount = Number.parseFloat(order.totalPriceSet?.shopMoney?.amount || '0')

      const existing = customerSpendMap.get(customerId)
      if (existing) {
        existing.totalSpent += amount
        existing.orderCount += 1
      } else {
        customerSpendMap.set(customerId, { totalSpent: amount, orderCount: 1 })
      }
    }

    const customerSpends = Array.from(customerSpendMap.values())
    if (customerSpends.length === 0) {
      return {
        success: true,
        output: {
          tiers: [],
          summary: {
            totalCustomers: 0,
            highSpendCustomers: 0,
            mediumSpendCustomers: 0,
            lowSpendCustomers: 0,
            averageCustomerSpend: 0,
            currency: 'USD',
          },
        },
      }
    }

    const sortedSpends = customerSpends.map((c) => c.totalSpent).sort((a, b) => a - b)
    const p66 = sortedSpends[Math.floor(sortedSpends.length * 0.66)] ?? 0
    const p33 = sortedSpends[Math.floor(sortedSpends.length * 0.33)] ?? 0

    let highCount = 0
    let highRevenue = 0
    let highOrders = 0
    let mediumCount = 0
    let mediumRevenue = 0
    let mediumOrders = 0
    let lowCount = 0
    let lowRevenue = 0
    let lowOrders = 0

    for (const customer of customerSpends) {
      if (customer.totalSpent >= p66) {
        highCount += 1
        highRevenue += customer.totalSpent
        highOrders += customer.orderCount
      } else if (customer.totalSpent >= p33) {
        mediumCount += 1
        mediumRevenue += customer.totalSpent
        mediumOrders += customer.orderCount
      } else {
        lowCount += 1
        lowRevenue += customer.totalSpent
        lowOrders += customer.orderCount
      }
    }

    const tiers: SpendTier[] = [
      {
        tier: 'High',
        customerCount: highCount,
        totalRevenue: Math.round(highRevenue * 100) / 100,
        averageOrderValue: highOrders > 0 ? Math.round((highRevenue / highOrders) * 100) / 100 : 0,
        averageOrderCount: highCount > 0 ? Math.round((highOrders / highCount) * 100) / 100 : 0,
      },
      {
        tier: 'Medium',
        customerCount: mediumCount,
        totalRevenue: Math.round(mediumRevenue * 100) / 100,
        averageOrderValue:
          mediumOrders > 0 ? Math.round((mediumRevenue / mediumOrders) * 100) / 100 : 0,
        averageOrderCount:
          mediumCount > 0 ? Math.round((mediumOrders / mediumCount) * 100) / 100 : 0,
      },
      {
        tier: 'Low',
        customerCount: lowCount,
        totalRevenue: Math.round(lowRevenue * 100) / 100,
        averageOrderValue: lowOrders > 0 ? Math.round((lowRevenue / lowOrders) * 100) / 100 : 0,
        averageOrderCount: lowCount > 0 ? Math.round((lowOrders / lowCount) * 100) / 100 : 0,
      },
    ]

    const totalSpend = customerSpends.reduce((s, c) => s + c.totalSpent, 0)
    const currency =
      allOrders.find((o: any) => o.totalPriceSet?.shopMoney?.currencyCode)?.totalPriceSet?.shopMoney
        ?.currencyCode || 'USD'

    return {
      success: true,
      output: {
        tiers,
        summary: {
          totalCustomers: customerSpends.length,
          highSpendCustomers: highCount,
          mediumSpendCustomers: mediumCount,
          lowSpendCustomers: lowCount,
          averageCustomerSpend: Math.round((totalSpend / customerSpends.length) * 100) / 100,
          currency,
        },
      },
    }
  },

  outputs: {
    tiers: {
      type: 'json',
      description: 'Customer spend tier breakdown',
    },
    summary: {
      type: 'json',
      description: 'Summary statistics for spend tiers',
    },
  },
}
