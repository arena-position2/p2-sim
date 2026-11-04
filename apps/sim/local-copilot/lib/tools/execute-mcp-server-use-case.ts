import { mcpServerDelegationPolicy } from '@/lib/mcp/application/authorization'
import { mcpServerOperations } from '@/lib/mcp/application/operations'
import { createCopilotApplicationAdapter } from '@/lib/mothership/application/application-adapter'
import { COPILOT_APPLICATION_DELEGATION_TTL_MS } from '@/lib/mothership/auth/application-delegation'

/**
 * Arena Local Copilot adapter for workspace MCP server registry use cases.
 * Kept under `local-copilot` so Sim merges need not restore a mothership
 * `manage-mcp-tool` / `manage-mcp-connection` handler module.
 */
export const executeCopilotMcpServerUseCase = createCopilotApplicationAdapter({
  domain: 'mcp server',
  delegation: {
    audience: mcpServerDelegationPolicy.audience,
    ttlMs: COPILOT_APPLICATION_DELEGATION_TTL_MS,
    createDelegationId: (context) => `copilot-tool:${context.toolCallId}`,
  },
  operations: {
    list: mcpServerOperations.list,
    register: mcpServerOperations.register,
    reconfigure: mcpServerOperations.reconfigure,
    delete: mcpServerOperations.delete,
  },
})
