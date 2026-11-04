import { mcpServerDelegationPolicy } from '@/lib/mcp/application/authorization'
import { mcpServerOperations } from '@/lib/mcp/application/operations'
import { createCopilotApplicationAdapter } from '@/lib/mothership/application/application-adapter'
import { COPILOT_APPLICATION_DELEGATION_TTL_MS } from '@/lib/mothership/auth/application-delegation'

/**
 * Arena Local Copilot adapter for MCP server use cases.
 *
 * Covers both directions Cloud used to route through one adapter:
 * - External connections agents *call* (`manage_mcp_connection`)
 * - Workflows published *as* MCP servers (`list/create/..._workspace_mcp_server`, `deploy_mcp`)
 *
 * Kept under `local-copilot` so Sim merges need not restore mothership
 * `manage-mcp-*` / deployment handler modules.
 */
export const executeCopilotMcpServerUseCase = createCopilotApplicationAdapter({
  domain: 'mcp server',
  delegation: {
    audience: mcpServerDelegationPolicy.audience,
    ttlMs: COPILOT_APPLICATION_DELEGATION_TTL_MS,
    createDelegationId: (context) => `copilot-tool:${context.toolCallId}`,
  },
  operations: mcpServerOperations,
})
