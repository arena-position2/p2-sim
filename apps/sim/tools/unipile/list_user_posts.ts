import type { ToolConfig } from '@/tools/types'
import { parseUnipilePagedBody } from '@/tools/unipile/parse_paged_body'
import type {
  UnipileListUserPostsParams,
  UnipileListUserPostsToolResponse,
} from '@/tools/unipile/types'

export const unipileListUserPostsTool: ToolConfig<
  UnipileListUserPostsParams,
  UnipileListUserPostsToolResponse
> = {
  id: 'unipile_list_user_posts',
  name: 'Unipile List all posts',
  description:
    'Returns posts written by a user or company (`GET /api/v1/users/{identifier}/posts`). Requires `account_id` and `user_identifier` (path). Optional `cursor`, `limit` (1–100), and LinkedIn `is_company`. Uses server `UNIPILE_API_KEY`.',
  version: '1.0.0',

  params: {
    account_id: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Unipile account id (required query parameter)',
    },
    user_identifier: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description:
        'Path `{identifier}`: provider id or public id (e.g. LinkedIn slug, or company id)',
    },
    cursor: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Pagination cursor from a previous response',
    },
    limit: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Optional `limit` query 1–100 (page size; number or string)',
    },
    is_company: {
      type: 'boolean',
      required: false,
      visibility: 'user-or-llm',
      description: 'LinkedIn: true when the identifier is a company page',
    },
  },

  request: {
    url: '/api/tools/unipile/list-user-posts',
    method: 'POST',
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (params) => {
      const out: Record<string, unknown> = {
        account_id:
          typeof params.account_id === 'string' ? params.account_id.trim() : params.account_id,
        user_identifier:
          typeof params.user_identifier === 'string'
            ? params.user_identifier.trim()
            : params.user_identifier,
      }
      if (typeof params.cursor === 'string' && params.cursor.trim() !== '') {
        out.cursor = params.cursor.trim()
      }
      if (params.limit != null && String(params.limit) !== '') {
        const n =
          typeof params.limit === 'number'
            ? params.limit
            : Number.parseInt(String(params.limit).trim(), 10)
        if (Number.isFinite(n) && n >= 1 && n <= 100) {
          out.limit = n
        }
      }
      if (params.is_company === true || params.is_company === false) {
        out.is_company = params.is_company
      }
      return out
    },
  },

  transformResponse: async (response: Response) => {
    const data = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : 'Unipile request failed')
    }

    return {
      success: true,
      output: parseUnipilePagedBody(data),
    }
  },

  outputs: {
    object: { type: 'string', description: 'Unipile object type (e.g. PostList)', optional: true },
    item_count: { type: 'number', description: 'Number of posts in this page' },
    items: { type: 'json', description: 'Post items' },
    cursor: { type: 'string', description: 'Next page cursor', optional: true },
    paging: { type: 'json', description: 'Paging metadata', optional: true },
    total_items: {
      type: 'number',
      description: 'Total items when returned by API',
      optional: true,
    },
  },
}
