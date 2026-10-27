import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/lib/api/client/request'
import {
  type AgentAccessRequestDecisionStatus,
  type AgentAccessRequestRow,
  approveAgentAccessRequestsContract,
  listAgentAccessRequestsContract,
} from '@/lib/api/contracts/agent-access-requests'

export const AGENT_ACCESS_REQUEST_LIST_STALE_TIME = 30 * 1000

export const agentAccessRequestKeys = {
  all: ['agentAccessRequests'] as const,
  lists: () => [...agentAccessRequestKeys.all, 'list'] as const,
  list: (workspaceId?: string) =>
    [...agentAccessRequestKeys.lists(), workspaceId ?? 'all'] as const,
}

async function fetchAgentAccessRequests(
  workspaceId: string | undefined,
  signal?: AbortSignal
): Promise<AgentAccessRequestRow[]> {
  const data = await requestJson(listAgentAccessRequestsContract, {
    query: workspaceId ? { workspaceId } : {},
    signal,
  })
  return data.rows
}

/**
 * Lists agent access requests. Pass a workspace id to scope the list; omit it for
 * the platform-admin global inbox at `/agent-access-request`.
 */
export function useAgentAccessRequests(workspaceId?: string) {
  return useQuery({
    queryKey: agentAccessRequestKeys.list(workspaceId),
    queryFn: ({ signal }) => fetchAgentAccessRequests(workspaceId, signal),
    staleTime: AGENT_ACCESS_REQUEST_LIST_STALE_TIME,
    placeholderData: keepPreviousData,
  })
}

interface ApproveAgentAccessRequestsVariables {
  accessIds: string[]
  status: AgentAccessRequestDecisionStatus
  approvedBy: string
}

export function useApproveAgentAccessRequests() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ accessIds, status, approvedBy }: ApproveAgentAccessRequestsVariables) => {
      await requestJson(approveAgentAccessRequestsContract, {
        body: {
          giveAccessList: accessIds.map((accessId) => ({ accessId, status })),
          approvedBy,
        },
      })
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: agentAccessRequestKeys.lists(),
      })
    },
  })
}
