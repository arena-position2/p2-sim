import { P2_TEAM_MEMBERS } from '@/tools/p2_docs/team-members'
import type { ToolConfig } from '@/tools/types'

interface GetP2UsersParams {
  filter?: string
}

interface GetP2UsersResponse {
  success: boolean
  output: {
    users: typeof P2_TEAM_MEMBERS
    total: number
  }
}

export const getP2UsersTool: ToolConfig<GetP2UsersParams, GetP2UsersResponse> = {
  id: 'p2_docs_get_p2_users',
  name: 'Get P2 Team Members',
  description:
    'Returns the list of Position2 (P2) team members — name, designation, and profile image URL — for use when populating team or speaker slides. Optionally filter by name or designation keyword.',
  version: '1.0.0',

  params: {
    filter: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Optional case-insensitive keyword to filter members by name or designation (e.g. "VP", "Board", "Rajiv").',
    },
  },

  request: {
    url: '/api/tools/p2_docs/get_p2_users',
    method: 'GET',
    headers: () => ({}),
  },

  outputs: {
    users: {
      type: 'array',
      description: 'List of matched P2 team members.',
      items: {
        type: 'json',
      },
    },
    total: {
      type: 'number',
      description: 'Total number of users returned.',
    },
  },
}

export async function executeGetP2UsersDirect(
  params: GetP2UsersParams
): Promise<GetP2UsersResponse> {
  const keyword = params.filter?.trim().toLowerCase()

  const users = keyword
    ? P2_TEAM_MEMBERS.filter(
        (m) =>
          m.name.toLowerCase().includes(keyword) || m.designation.toLowerCase().includes(keyword)
      )
    : P2_TEAM_MEMBERS

  return {
    success: true,
    output: {
      users,
      total: users.length,
    },
  }
}
