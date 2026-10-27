'use client'

import { ChipLink } from '@sim/emcn'
import { Zap } from '@sim/emcn/icons'
import { ARENA_GENERATIVE_APP_BASE_PATH } from '@/lib/arena-generative-ui/types'
import { workflowRunCTAEvent } from '@/app/arenaMixpanelEvents/mixpanelEvents'
import { useGenerativeAppStatus } from '@/hooks/queries/arena-generative-apps'
import { useChatDeploymentStatus } from '@/hooks/queries/deployments'
import { useWorkspaceSettings } from '@/hooks/queries/workspace'

interface LaunchDeployedChatProps {
  workflowId: string | null
  workspaceId: string
}

/**
 * Arena control on the workflow builder panel. Opens the deployed chat, the app
 * redirect, or a published generative app. Upstream's Run button stays the
 * in-builder execution. On an upstream panel merge, keep Run as upstream wrote
 * it and render this component beside it.
 */
export function LaunchDeployedChat({ workflowId, workspaceId }: LaunchDeployedChatProps) {
  const { data } = useChatDeploymentStatus(workflowId)
  const { data: appStatus } = useGenerativeAppStatus(workflowId ?? undefined)
  const { data: workspaceData } = useWorkspaceSettings(workspaceId)
  const workspaceName = workspaceData?.settings?.workspace?.name ?? ''

  const deployment = data?.isDeployed ? data.deployment : null
  const identifier = deployment?.identifier
  const redirectUrl = deployment?.redirectUrl
  const appRedirect =
    deployment?.deploymentType === 'app' &&
    typeof redirectUrl === 'string' &&
    redirectUrl.length > 0
      ? redirectUrl
      : null
  const chatHref = identifier
    ? (appRedirect ?? `/chat/${identifier}?workspaceId=${workspaceId}&fromControlBar=true`)
    : null
  const appIdentifier =
    appStatus?.isDeployed && appStatus.deployment?.identifier
      ? appStatus.deployment.identifier
      : null
  const href =
    chatHref ?? (appIdentifier ? `${ARENA_GENERATIVE_APP_BASE_PATH}/${appIdentifier}` : null)
  if (!href) return null

  const opensNewTab = href.startsWith('http://') || href.startsWith('https://')

  return (
    <ChipLink
      href={href}
      mobileCompact
      variant='primary'
      leftIcon={Zap}
      target={opensNewTab ? '_blank' : undefined}
      rel={opensNewTab ? 'noopener noreferrer' : undefined}
      aria-label='Launch'
      onClick={() =>
        workflowRunCTAEvent({
          'Workspace Name': workspaceName,
          'Workspace ID': workspaceId,
        })
      }
    >
      Launch
    </ChipLink>
  )
}
