import type { ChatDetail } from '@/lib/api/contracts/deployments'
import type { ChatDeploymentView } from '@/lib/chat-deployments/application'

/**
 * Projects a chat deployment onto the internal editor's detail shape.
 *
 * The stored `customizations`, `allowedEmails`, and `outputConfigs` are
 * schemaless JSON columns, so their defaults are applied here rather than
 * assumed: a row written before a field existed reads as its empty value
 * instead of `null` reaching the client.
 *
 * Golden queries live in `workflow_queries`, not `chat.customizations`. Pass
 * the table strings so the deploy modal sees the same list as the live chat.
 */
export function toChatDetailResponse(
  deployment: ChatDeploymentView,
  chatUrl: string,
  goldenQueries: string[] = []
): ChatDetail {
  const storedCustomizations =
    (deployment.customizations as ChatDetail['customizations'] | null) ?? undefined

  return {
    id: deployment.id,
    identifier: deployment.identifier,
    title: deployment.title,
    description: deployment.description ?? '',
    department: deployment.department ?? '',
    authType: deployment.authType as ChatDetail['authType'],
    allowedEmails: (deployment.allowedEmails as string[] | null) ?? [],
    outputConfigs: (deployment.outputConfigs as ChatDetail['outputConfigs'] | null) ?? [],
    includeThinking: deployment.includeThinking,
    includeToolCalls: deployment.includeToolCalls,
    customizations: {
      ...(storedCustomizations ?? {}),
      goldenQueries,
    },
    isActive: deployment.isActive,
    deploymentType: (deployment.deploymentType as ChatDetail['deploymentType'] | null) ?? 'chat',
    redirectUrl: deployment.redirectUrl ?? null,
    chatUrl,
    hasPassword: deployment.hasPassword,
  }
}
