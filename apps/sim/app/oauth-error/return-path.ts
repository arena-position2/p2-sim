import { resourceScopeFromOwner } from '@/lib/core/resource-scope'
import { ADD_CONNECTOR_SEARCH_PARAM, type OAuthReturnContext } from '@/lib/credentials/client-state'
import { APP_ENTRY_PATH, organizationRoutes } from '@/lib/navigation/paths'
import { organizationSearchSetupPath } from '@/lib/sim-search/setup-navigation'

/** Same freshness window as `useOAuthReturnRouter` — stale context must not send people elsewhere. */
export const OAUTH_RETURN_CONTEXT_MAX_AGE_MS = 15 * 60 * 1000

/**
 * Where "Return to Arena AI" should send someone who landed on `/oauth-error`
 * after a provider cancel or admin-consent request. Uses the connect modal's
 * `sim.oauth-return-context` when it is still fresh; otherwise the app entry.
 *
 * Never restarts OAuth — the caller only navigates.
 */
export function resolveOAuthErrorReturnPath(
  ctx: OAuthReturnContext | null,
  now = Date.now()
): string {
  if (!ctx) return APP_ENTRY_PATH
  if (now - ctx.requestedAt > OAUTH_RETURN_CONTEXT_MAX_AGE_MS) return APP_ENTRY_PATH

  if (ctx.origin === 'workflow') {
    return `/workspace/${ctx.workspaceId}/w/${ctx.workflowId}`
  }

  if (ctx.origin === 'integrations') {
    if (ctx.organizationId) return organizationRoutes(ctx.organizationId).integrations
    if (ctx.workspaceId) return `/workspace/${ctx.workspaceId}/settings/integrations`
    return APP_ENTRY_PATH
  }

  if (ctx.origin === 'kb-connectors') {
    try {
      const scope = resourceScopeFromOwner(ctx)
      if (scope.kind === 'organization' && ctx.connectorId) {
        return `${organizationRoutes(scope.organizationId).searchSource(ctx.connectorId)}?view=settings`
      }
      if (scope.kind === 'organization') {
        return organizationSearchSetupPath(scope.organizationId)
      }
      const kbUrl = `/workspace/${scope.workspaceId}/knowledge/${ctx.knowledgeBaseId}`
      return ctx.connectorType
        ? `${kbUrl}?${ADD_CONNECTOR_SEARCH_PARAM}=${encodeURIComponent(ctx.connectorType)}`
        : kbUrl
    } catch {
      return APP_ENTRY_PATH
    }
  }

  return APP_ENTRY_PATH
}
