import type { ToolConfig } from '@/tools/types'

export interface ShopifyCustomersOverTimeParams {
  shopDomain: string
  accessToken: string
  idToken?: string
  startDate?: string
  endDate?: string
  groupBy?: 'day' | 'week' | 'month'
}

export interface ShopifyCustomersOverTimeResponse {
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

export const shopifyCustomersOverTimeTool: ToolConfig<
  ShopifyCustomersOverTimeParams,
  ShopifyCustomersOverTimeResponse
> = {
  id: 'shopify_customers_over_time',
  name: 'Shopify Customers Over Time',
  description: 'Get new customer counts over time periods (day/week/month)',
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
        if (params.startDate) {
          dateParts.push(`createdAt:>=${params.startDate}`)
        }
        if (params.endDate) {
          dateParts.push(`createdAt:<=${params.endDate}`)
        }
        dateQuery = dateParts.join(' ')
      }

      return {
        query: `
          query getCustomersOverTime($first: Int!, $query: String) {
            customers(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  email
                  createdAt
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
    let allCustomers: any[] = []

    const fetchAllCustomers = async (currentCursor: string | null) => {
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
              query getCustomersOverTime($first: Int!, $query: String, $after: String) {
                customers(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      id
                      email
                      createdAt
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
      if (data.errors) throw new Error(data.errors[0]?.message || 'Failed to fetch customers')

      const customersData = data.data?.customers
      if (!customersData) return

      allCustomers = [...allCustomers, ...customersData.edges.map((edge: any) => edge.node)]

      if (customersData.pageInfo.hasNextPage) {
        const lastCursor = customersData.edges[customersData.edges.length - 1].cursor
        await fetchAllCustomers(lastCursor)
      }
    }

    function buildDateQuery(p: any) {
      let dateQuery = ''
      if (p.startDate || p.endDate) {
        const dateParts: string[] = []
        if (p.startDate) dateParts.push(`createdAt:>=${p.startDate}`)
        if (p.endDate) dateParts.push(`createdAt:<=${p.endDate}`)
        dateQuery = dateParts.join(' ')
      }
      return dateQuery || null
    }

    try {
      await fetchAllCustomers(null)
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        output: {
          customerData: [],
          summary: { totalNewCustomers: 0 },
        },
      }
    }

    const customers = allCustomers
    const groupBy = params?.groupBy || 'day'
    const customerData: Record<string, number> = {}

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

    customers.forEach((customer: any) => {
      const { year, month, day, dayOfWeek } = toStoreDateParts(customer.createdAt)

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
      description: 'Aggregated customer data grouped by time period',
    },
    summary: {
      type: 'object',
      description: 'Summary statistics for the selected period',
    },
  },
}
