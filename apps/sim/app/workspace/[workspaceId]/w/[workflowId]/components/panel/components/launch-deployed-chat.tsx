'use client'

import { ChipLink } from '@sim/emcn'
import { Zap } from '@sim/emcn/icons'
import { workflowRunCTAEvent } from '@/app/arenaMixpanelEvents/mixpanelEvents'
import { useChatDeploymentStatus } from '@/hooks/queries/deployments'
import { useWorkspaceSettings } from '@/hooks/queries/workspace'

interface LaunchDeployedChatProps {
  workflowId: string | null
  workspaceId: string
}

/**
 * Arena control on the workflow builder panel. Opens the deployed chat, or the
 * app redirect, for workflows that have one. Upstream's Run button stays the
 * in-builder execution. On an upstream panel merge, keep Run as upstream wrote
 * it and render this component beside it.
 */
export function LaunchDeployedChat({ workflowId, workspaceId }: LaunchDeployedChatProps) {
  const { data } = useChatDeploymentStatus(workflowId)
  const { data: workspaceData } = useWorkspaceSettings(workspaceId)
  const workspaceName = workspaceData?.settings?.workspace?.name ?? ''

  const deployment = data?.isDeployed ? data.deployment : null
  const identifier = deployment?.identifier
  if (!identifier) return null

  const redirectUrl = deployment?.redirectUrl
  const appRedirect =
    deployment?.deploymentType === 'app' &&
    typeof redirectUrl === 'string' &&
    redirectUrl.length > 0
      ? redirectUrl
      : null
  const href = appRedirect ?? `/chat/${identifier}?workspaceId=${workspaceId}&fromControlBar=true`

  return (
    <ChipLink
      href={href}
      mobileCompact
      variant='primary'
      className='min-w-[30px] shrink'
      leftIcon={Zap}
      target={appRedirect ? '_blank' : undefined}
      rel={appRedirect ? 'noopener noreferrer' : undefined}
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
