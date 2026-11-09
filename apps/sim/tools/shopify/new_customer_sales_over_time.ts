import type { ToolConfig } from '@/tools/types'

export interface ShopifyNewCustomerSalesOverTimeParams {
  shopDomain: string
  accessToken: string
  idToken?: string
  startDate?: string
  endDate?: string
  groupBy?: 'day' | 'week' | 'month'
}

export interface ShopifyNewCustomerSalesOverTimeResponse {
  success: boolean
  error?: string
  output: {
    salesData: Array<{
      period: string
      totalSales: number
      newCustomerOrderCount: number
      currency: string
    }>
    summary: {
      totalNewCustomerSales: number
      totalNewCustomerOrders: number
      averageNewCustomerOrderValue: number
      currency: string
    }
  }
}

export const shopifyNewCustomerSalesOverTimeTool: ToolConfig<
  ShopifyNewCustomerSalesOverTimeParams,
  ShopifyNewCustomerSalesOverTimeResponse
> = {
  id: 'shopify_new_customer_sales_over_time',
  name: 'Shopify New Customer Sales Over Time',
  description: 'Get sales data from first-time customers over time periods (day/week/month)',
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
      description: 'Start date for sales data (format: YYYY-MM-DD)',
    },
    endDate: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'End date for sales data (format: YYYY-MM-DD)',
    },
    groupBy: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Group sales by day, week, or month (default: day)',
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
          query getOrdersForNewCustomerSales($first: Int!, $query: String) {
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
              query getOrdersForNewCustomerSales($first: Int!, $query: String, $after: String) {
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
          salesData: [],
          summary: {
            totalNewCustomerSales: 0,
            totalNewCustomerOrders: 0,
            averageNewCustomerOrderValue: 0,
            currency: 'USD',
          },
        },
      }
    }

    const newCustomerOrders = allOrders.filter(
      (order: any) => !order.test && order.customer?.ordersCount === 1
    )

    const groupBy = params?.groupBy || 'day'
    const salesData: Record<string, { total: number; count: number; currency: string }> = {}

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

    newCustomerOrders.forEach((order: any) => {
      const amount = Number.parseFloat(order.totalPriceSet?.shopMoney?.amount || '0')
      const currency = order.totalPriceSet?.shopMoney?.currencyCode || 'USD'
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

      if (!salesData[periodKey]) {
        salesData[periodKey] = { total: 0, count: 0, currency }
      }
      salesData[periodKey].total += amount
      salesData[periodKey].count += 1
    })

    const sortedSalesData = Object.entries(salesData)
      .map(([period, data]) => ({
        period,
        totalSales: Math.round(data.total * 100) / 100,
        newCustomerOrderCount: data.count,
        currency: data.currency,
      }))
      .sort((a, b) => a.period.localeCompare(b.period))

    const totalNewCustomerSales = sortedSalesData.reduce((sum, item) => sum + item.totalSales, 0)
    const totalNewCustomerOrders = sortedSalesData.reduce(
      (sum, item) => sum + item.newCustomerOrderCount,
      0
    )
    const averageNewCustomerOrderValue =
      totalNewCustomerOrders > 0 ? totalNewCustomerSales / totalNewCustomerOrders : 0
    const currency = sortedSalesData[0]?.currency || 'USD'

    return {
      success: true,
      output: {
        salesData: sortedSalesData,
        summary: {
          totalNewCustomerSales: Math.round(totalNewCustomerSales * 100) / 100,
          totalNewCustomerOrders,
          averageNewCustomerOrderValue: Math.round(averageNewCustomerOrderValue * 100) / 100,
          currency,
        },
      },
    }
  },

  outputs: {
    salesData: {
      type: 'array',
      description: 'New customer sales data grouped by time period',
    },
    summary: {
      type: 'object',
      description: 'Summary statistics for new customer sales',
    },
  },
}
