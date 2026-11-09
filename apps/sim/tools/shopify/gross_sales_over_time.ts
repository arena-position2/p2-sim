import type { ToolConfig } from '@/tools/types'

export interface ShopifyGrossSalesOverTimeParams {
  shopDomain: string
  accessToken: string
  idToken?: string
  startDate?: string // Format: YYYY-MM-DD
  endDate?: string // Format: YYYY-MM-DD
  groupBy?: 'day' | 'week' | 'month' // Default: 'day'
}

export interface ShopifyGrossSalesOverTimeResponse {
  success: boolean
  error?: string
  output: {
    salesData: Array<{
      period: string
      totalSales: number
      orderCount: number
      currency: string
    }>
    summary: {
      totalSales: number
      totalOrders: number
      averageOrderValue: number
      currency: string
    }
  }
}

export const shopifyGrossSalesOverTimeTool: ToolConfig<
  ShopifyGrossSalesOverTimeParams,
  ShopifyGrossSalesOverTimeResponse
> = {
  id: 'shopify_gross_sales_over_time',
  name: 'Shopify Gross Sales Over Time',
  description: 'Get aggregated gross sales data over time periods (day/week/month)',
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
      // Build date filter query
      let dateQuery = ''
      if (params.startDate || params.endDate) {
        const dateParts: string[] = []
        if (params.startDate) {
          dateParts.push(`created_at:>=${params.startDate}`)
        }
        if (params.endDate) {
          dateParts.push(`created_at:<=${params.endDate}`)
        }
        dateQuery = dateParts.join(' ')
      }

      return {
        query: `
          query getOrdersForSales($first: Int!, $query: String) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  name
                  createdAt
                  totalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  displayFinancialStatus
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
            query getOrdersForSales($first: Int!, $query: String, $after: String) {
              orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
                edges {
                  node {
                    id
                    name
                    createdAt
                    lineItems(first: 250) {
                      edges {
                        node {
                          quantity
                          originalTotalSet {
                            shopMoney {
                              amount
                              currencyCode
                            }
                          }
                          taxLines {
                            priceSet {
                              shopMoney {
                                amount
                              }
                            }
                          }
                        }
                      }
                    }
                    totalPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    displayFinancialStatus
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

    try {
      await fetchAllOrders(null)
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        output: {
          salesData: [],
          summary: { totalSales: 0, totalOrders: 0, averageOrderValue: 0, currency: 'USD' },
        },
      }
    }

    const orders = allOrders

    // Group orders by time period
    const groupBy = params?.groupBy || 'day'
    const salesData: Record<string, { total: number; count: number; currency: string }> = {}

    const STORE_TZ = 'America/New_York'

    function toStoreDateParts(isoDate: string): {
      year: number
      month: number
      day: number
      dayOfWeek: number
    } {
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

    const filteredOrders = orders.filter((order: any) => !order.test)

    filteredOrders.forEach((order: any) => {
      // Gross Sales = sum of originalTotalSet per line item (pre-discount, pre-tax for tax-exclusive stores)
      let orderGrossSales = 0
      const lineItems = order.lineItems?.edges || []
      for (const edge of lineItems) {
        const item = edge.node
        orderGrossSales += Number.parseFloat(item.originalTotalSet?.shopMoney?.amount || '0')
      }
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
      salesData[periodKey].total += orderGrossSales
      salesData[periodKey].count += 1
    })

    // Convert to sorted array (chronological order)
    const sortedSalesData = Object.entries(salesData)
      .map(([period, data]) => ({
        period,
        totalSales: Math.round(data.total * 100) / 100, // Round to 2 decimal places
        orderCount: data.count,
        currency: data.currency,
      }))
      .sort((a, b) => a.period.localeCompare(b.period))

    // Calculate summary
    const totalSales = sortedSalesData.reduce((sum, item) => sum + item.totalSales, 0)
    const totalOrders = sortedSalesData.reduce((sum, item) => sum + item.orderCount, 0)
    const averageOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0
    const currency = sortedSalesData[0]?.currency || 'USD'

    return {
      success: true,
      output: {
        salesData: sortedSalesData,
        summary: {
          totalSales: Math.round(totalSales * 100) / 100,
          totalOrders,
          averageOrderValue: Math.round(averageOrderValue * 100) / 100,
          currency,
        },
      },
    }
  },

  outputs: {
    salesData: {
      type: 'array',
      description: 'Aggregated sales data grouped by time period',
    },
    summary: {
      type: 'object',
      description: 'Summary statistics for the selected period',
    },
  },
}
