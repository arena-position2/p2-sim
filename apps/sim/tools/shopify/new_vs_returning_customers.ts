import type { ToolConfig } from '@/tools/types'

export interface ShopifyNewVsReturningCustomersParams {
  shopDomain: string
  accessToken: string
  idToken?: string
  startDate?: string
  endDate?: string
  groupBy?: 'day' | 'week' | 'month'
}

export interface ShopifyNewVsReturningCustomersResponse {
  success: boolean
  error?: string
  output: {
    data: Array<{
      period: string
      newCustomerOrders: number
      returningCustomerOrders: number
      newCustomerRevenue: number
      returningCustomerRevenue: number
    }>
    summary: {
      totalNewCustomerOrders: number
      totalReturningCustomerOrders: number
      totalNewCustomerRevenue: number
      totalReturningCustomerRevenue: number
      newCustomerPercentage: number
      returningCustomerPercentage: number
    }
  }
}

export const shopifyNewVsReturningCustomersTool: ToolConfig<
  ShopifyNewVsReturningCustomersParams,
  ShopifyNewVsReturningCustomersResponse
> = {
  id: 'shopify_new_vs_returning_customers',
  name: 'Shopify New vs Returning Customers',
  description: 'Compare new vs returning customer orders and revenue over time',
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
    groupBy: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Group by day, week, or month (default: day)',
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
          query getOrdersForCustomerAnalysis($first: Int!, $query: String) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  createdAt
                  totalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  customer {
                    id
                    ordersCount
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
              query getOrdersForCustomerAnalysis($first: Int!, $query: String, $after: String) {
                orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      id
                      createdAt
                      totalPriceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                      customer {
                        id
                        ordersCount
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
          data: [],
          summary: {
            totalNewCustomerOrders: 0,
            totalReturningCustomerOrders: 0,
            totalNewCustomerRevenue: 0,
            totalReturningCustomerRevenue: 0,
            newCustomerPercentage: 0,
            returningCustomerPercentage: 0,
          },
        },
      }
    }

    const filteredOrders = allOrders.filter((order: any) => !order.test)
    const groupBy = params?.groupBy || 'day'
    const periodData: Record<
      string,
      {
        newOrders: number
        returningOrders: number
        newRevenue: number
        returningRevenue: number
      }
    > = {}

    const STORE_TZ = 'America/New_York'

    function toStoreDateParts(isoDate: string) {
      const d = new Date(isoDate)
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: STORE_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(d)
      const year = Number.parseInt(parts.find((p) => p.type === 'year')!.value, 10)
      const month = Number.parseInt(parts.find((p) => p.type === 'month')!.value, 10)
      const day = Number.parseInt(parts.find((p) => p.type === 'day')!.value, 10)
      const localDate = new Date(d.toLocaleString('en-US', { timeZone: STORE_TZ }))
      const dayOfWeek = localDate.getDay()
      return { year, month, day, dayOfWeek }
    }

    function pad(n: number): string {
      return n.toString().padStart(2, '0')
    }

    filteredOrders.forEach((order: any) => {
      const amount = Number.parseFloat(order.totalPriceSet?.shopMoney?.amount || '0')
      const isNewCustomer = order.customer?.ordersCount === 1
      const { year, month, day, dayOfWeek } = toStoreDateParts(order.createdAt)

      let periodKey: string
      switch (groupBy as 'day' | 'week' | 'month') {
        case 'day':
          periodKey = `${year}-${pad(month)}-${pad(day)}`
          break
        case 'week': {
          const d = new Date(year, month - 1, day)
          d.setDate(d.getDate() - dayOfWeek)
          periodKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
          break
        }
        case 'month':
          periodKey = `${year}-${pad(month)}`
          break
        default:
          periodKey = `${year}-${pad(month)}-${pad(day)}`
      }

      if (!periodData[periodKey]) {
        periodData[periodKey] = {
          newOrders: 0,
          returningOrders: 0,
          newRevenue: 0,
          returningRevenue: 0,
        }
      }

      if (isNewCustomer) {
        periodData[periodKey].newOrders += 1
        periodData[periodKey].newRevenue += amount
      } else {
        periodData[periodKey].returningOrders += 1
        periodData[periodKey].returningRevenue += amount
      }
    })

    const sortedData = Object.entries(periodData)
      .map(([period, data]) => ({
        period,
        newCustomerOrders: data.newOrders,
        returningCustomerOrders: data.returningOrders,
        newCustomerRevenue: Math.round(data.newRevenue * 100) / 100,
        returningCustomerRevenue: Math.round(data.returningRevenue * 100) / 100,
      }))
      .sort((a, b) => a.period.localeCompare(b.period))

    const totalNewCustomerOrders = sortedData.reduce((s, i) => s + i.newCustomerOrders, 0)
    const totalReturningCustomerOrders = sortedData.reduce(
      (s, i) => s + i.returningCustomerOrders,
      0
    )
    const totalNewCustomerRevenue = sortedData.reduce((s, i) => s + i.newCustomerRevenue, 0)
    const totalReturningCustomerRevenue = sortedData.reduce(
      (s, i) => s + i.returningCustomerRevenue,
      0
    )
    const totalOrders = totalNewCustomerOrders + totalReturningCustomerOrders

    return {
      success: true,
      output: {
        data: sortedData,
        summary: {
          totalNewCustomerOrders,
          totalReturningCustomerOrders,
          totalNewCustomerRevenue: Math.round(totalNewCustomerRevenue * 100) / 100,
          totalReturningCustomerRevenue: Math.round(totalReturningCustomerRevenue * 100) / 100,
          newCustomerPercentage:
            totalOrders > 0 ? Math.round((totalNewCustomerOrders / totalOrders) * 10000) / 100 : 0,
          returningCustomerPercentage:
            totalOrders > 0
              ? Math.round((totalReturningCustomerOrders / totalOrders) * 10000) / 100
              : 0,
        },
      },
    }
  },

  outputs: {
    data: {
      type: 'array',
      description: 'New vs returning customer data grouped by time period',
    },
    summary: {
      type: 'object',
      description: 'Summary statistics comparing new vs returning customers',
    },
  },
}
