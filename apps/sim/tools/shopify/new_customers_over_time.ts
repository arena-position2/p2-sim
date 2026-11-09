import type { ToolConfig } from '@/tools/types'

export interface ShopifyNewCustomersOverTimeParams {
  shopDomain: string
  accessToken: string
  idToken?: string
  startDate?: string
  endDate?: string
  groupBy?: 'day' | 'week' | 'month'
}

export interface ShopifyNewCustomersOverTimeResponse {
  success: boolean
  error?: string
  output: {
    customerData: Array<{
      period: string
      newCustomerCount: number
    }>
    summary: {
      totalNewCustomers: number
    }
  }
}

export const shopifyNewCustomersOverTimeTool: ToolConfig<
  ShopifyNewCustomersOverTimeParams,
  ShopifyNewCustomersOverTimeResponse
> = {
  id: 'shopify_new_customers_over_time',
  name: 'Shopify New Customers Over Time',
  description: 'Get new customer acquisition counts over time periods (day/week/month)',
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
      description: 'Start date for customer data (format: YYYY-MM-DD)',
    },
    endDate: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'End date for customer data (format: YYYY-MM-DD)',
    },
    groupBy: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Group customers by day, week, or month (default: day)',
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
          query getOrdersForNewCustomers($first: Int!, $query: String) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  createdAt
                  customer {
                    id
                    createdAt
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
              query getOrdersForNewCustomers($first: Int!, $query: String, $after: String) {
                orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      id
                      createdAt
                      customer {
                        id
                        createdAt
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
          customerData: [],
          summary: { totalNewCustomers: 0 },
        },
      }
    }

    const seenCustomerIds = new Set<string>()
    const newCustomerOrders = allOrders.filter((order: any) => {
      if (order.test || !order.customer?.id) return false
      if (order.customer.ordersCount !== 1) return false
      if (seenCustomerIds.has(order.customer.id)) return false
      seenCustomerIds.add(order.customer.id)
      return true
    })

    const groupBy = params?.groupBy || 'day'
    const customerData: Record<string, number> = {}

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

      if (!customerData[periodKey]) {
        customerData[periodKey] = 0
      }
      customerData[periodKey] += 1
    })

    const sortedCustomerData = Object.entries(customerData)
      .map(([period, count]) => ({
        period,
        newCustomerCount: count,
      }))
      .sort((a, b) => a.period.localeCompare(b.period))

    const totalNewCustomers = sortedCustomerData.reduce(
      (sum, item) => sum + item.newCustomerCount,
      0
    )

    return {
      success: true,
      output: {
        customerData: sortedCustomerData,
        summary: {
          totalNewCustomers,
        },
      },
    }
  },

  outputs: {
    customerData: {
      type: 'array',
      description: 'New customer counts grouped by time period',
    },
    summary: {
      type: 'object',
      description: 'Summary statistics for new customers',
    },
  },
}
