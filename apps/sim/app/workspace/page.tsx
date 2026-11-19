'use client'

import { useEffect, useRef, useState } from 'react'
import { Chip } from '@sim/emcn'
import { CircleAlert } from '@sim/emcn/icons'
import { createLogger } from '@sim/logger'
import { useRouter } from 'next/navigation'
import { isApiClientError } from '@/lib/api/client/errors'
import { requestJson } from '@/lib/api/client/request'
import { getWorkflowStateContract } from '@/lib/api/contracts/workflows'
import { createWorkspaceContract } from '@/lib/api/contracts/workspaces'
import {
  ARENA_SSO_SESSION_REQUIRED_PATH,
  buildArenaSimResumeUrl,
} from '@/lib/auth/arena-sim-resume'
import { useSession } from '@/lib/auth/auth-client'
// import { recoverFromStaleSession } from '@/lib/auth/stale-session-recovery'
import {
  buildUpgradeHref,
  isUpgradeReason,
  UPGRADE_REASON_PARAM,
} from '@/lib/billing/upgrade-reasons'
import { isLocalLoginEnabled } from '@/lib/core/config/env-flags'
import { ApplicationLoading } from '@/app/_shell/application-loading'
import { DesktopTitleBarLane } from '@/app/_shell/desktop-title-bar'
import { useWorkspacesWithMetadata } from '@/hooks/queries/workspace'
import { fetchUserProfileSetPeopleMP } from '@/utilities/mixPanelTrigger'

const logger = createLogger('WorkspacePage')

/** Bounds the one-shot reload after a creation-vs-membership 409. */
const WORKSPACE_RACE_RETRY_KEY = 'workspaceRaceRetry'

interface WorkspaceStatusCardProps {
  title: string
  description: string
  primaryLabel: string
  onPrimary: () => void
}

function WorkspaceStatusCard({
  title,
  description,
  primaryLabel,
  onPrimary,
}: WorkspaceStatusCardProps) {
  return (
    <main className='desktop-title-bar-page flex w-full items-center justify-center bg-[var(--surface-1)] p-6'>
      <DesktopTitleBarLane />
      <div className='flex max-w-md flex-col items-center gap-3 text-center'>
        <div className='flex size-10 items-center justify-center rounded-full bg-[var(--surface-3)]'>
          <CircleAlert className='size-[18px] text-[var(--text-icon)]' aria-hidden />
        </div>
        <div className='space-y-1'>
          <h1 className='text-[var(--text-primary)] text-lg'>{title}</h1>
          <p className='text-[var(--text-muted)] text-sm'>{description}</p>
        </div>
        <div className='flex items-center gap-2'>
          <Chip variant='primary' onClick={onPrimary}>
            {primaryLabel}
          </Chip>
        </div>
      </div>
    </main>
  )
}

export default function WorkspacePage() {
  const router = useRouter()
  const { data: session, isPending: isSessionPending, error: sessionError } = useSession()
  const isAuthenticated = !isSessionPending && !!session?.user
  const hasRedirectedRef = useRef(false)
  const blockedLoggedRef = useRef(false)
  const [recoveryFailed, setRecoveryFailed] = useState(false)

  const {
    data,
    isLoading: isWorkspacesLoading,
    error: workspacesError,
  } = useWorkspacesWithMetadata(isAuthenticated)

  // Do not auto sign-out on stale/401 session here — that races session recovery
  // when profile/session briefly fails.

  useEffect(() => {
    fetchUserProfileSetPeopleMP()
  }, [])

  useEffect(() => {
    if (isSessionPending || hasRedirectedRef.current) return

    if (!session?.user) {
      if (isLocalLoginEnabled) {
        logger.info('User not authenticated, redirecting to login')
        router.replace('/login')
        return
      }
      logger.info('User not authenticated, redirecting to Arena SSO resume')
      const resume = buildArenaSimResumeUrl(window.location.href, window.location.hostname)
      window.location.assign(resume?.href ?? ARENA_SSO_SESSION_REQUIRED_PATH)
      return
    }

    if (isWorkspacesLoading || workspacesError || !data) return

    const urlParams = new URLSearchParams(window.location.search)
    const redirectWorkflowId = urlParams.get('redirect_workflow')
    const redirectTarget = urlParams.get('redirect')
    const rawReason = urlParams.get(UPGRADE_REASON_PARAM)

    /** Preserve settings and upgrade destinations when selecting or creating a workspace. */
    const destinationFor = (id: string) =>
      redirectTarget === 'upgrade'
        ? buildUpgradeHref(id, isUpgradeReason(rawReason) ? rawReason : undefined)
        : redirectTarget === 'settings'
          ? `/workspace/${id}/settings/general`
          : `/workspace/${id}`

    const { workspaces, lastActiveWorkspaceId, creationPolicy } = data

    if (workspaces.length === 0) {
      /**
       * Blocked state is derived in render and deliberately does NOT set
       * hasRedirectedRef: a later refetch that shows granted access resumes
       * the normal redirect path, so the screen self-heals.
       */
      if (creationPolicy && !creationPolicy.canCreate) {
        if (!blockedLoggedRef.current) {
          blockedLoggedRef.current = true
          logger.warn('No workspaces found and workspace creation is blocked', {
            reason: creationPolicy.reason,
            workspaceMode: creationPolicy.workspaceMode,
            organizationId: creationPolicy.organizationId,
          })
        }
        return
      }
      hasRedirectedRef.current = true
      handleNoWorkspaces(router, () => setRecoveryFailed(true), destinationFor)
      return
    }

    hasRedirectedRef.current = true

    const targetWorkspace = workspaces.find((w) => w.id === lastActiveWorkspaceId) ?? workspaces[0]

    if (redirectWorkflowId) {
      handleWorkflowRedirect(redirectWorkflowId, targetWorkspace.id, router)
      return
    }

    logger.info(`Redirecting to workspace: ${targetWorkspace.id}`)
    router.replace(destinationFor(targetWorkspace.id))
  }, [session, isSessionPending, isWorkspacesLoading, workspacesError, data, router])

  const blockedPolicy =
    isAuthenticated &&
    data &&
    data.workspaces.length === 0 &&
    data.creationPolicy &&
    !data.creationPolicy.canCreate
      ? data.creationPolicy
      : null

  if (blockedPolicy) {
    return (
      <WorkspaceStatusCard
        title='No workspace access yet'
        description={
          blockedPolicy.blockedReasonCode === 'organization-subscription-inactive'
            ? "Your organization's subscription is inactive, so new workspaces can't be created. Ask an organization owner to reactivate it."
            : blockedPolicy.blockedReasonCode === 'permission-group-denied'
              ? "Your permission group doesn't allow creating workspaces, and you don't have access to an existing one. Ask an organization admin for workspace access."
              : blockedPolicy.workspaceMode === 'organization'
                ? "Your account is linked to an organization, but you don't have access to any of its workspaces. Ask an organization admin for workspace access, then check again — or sign out and back in if you recently left the organization."
                : 'Your plan has reached its workspace limit and none of your workspaces are active. Upgrade your plan to create another workspace, or contact support to restore an archived one.'
        }
        primaryLabel='Check again'
        onPrimary={() => window.location.reload()}
      />
    )
  }

  const failedToLoad =
    recoveryFailed ||
    (Boolean(sessionError) && !session?.user) ||
    (isAuthenticated && Boolean(workspacesError))

  if (failedToLoad) {
    return (
      <WorkspaceStatusCard
        title='Could not load your workspaces'
        description='Something went wrong while loading your account. Try again.'
        primaryLabel='Try again'
        onPrimary={() => window.location.reload()}
      />
    )
  }

  return <ApplicationLoading />
}

async function handleWorkflowRedirect(
  workflowId: string,
  fallbackWorkspaceId: string,
  router: ReturnType<typeof useRouter>
): Promise<void> {
  try {
    const workflowData = await requestJson(getWorkflowStateContract, {
      params: { id: workflowId },
    })
    const workspaceId = workflowData.data.workspaceId
    if (workspaceId) {
      logger.info(`Redirecting workflow ${workflowId} to workspace ${workspaceId}`)
      router.replace(`/workspace/${workspaceId}/w/${workflowId}`)
      return
    }
  } catch (error) {
    logger.error('Error fetching workflow for redirect:', error)
  }
  router.replace(`/workspace/${fallbackWorkspaceId}`)
}

async function handleNoWorkspaces(
  router: ReturnType<typeof useRouter>,
  onUnrecoverable: () => void,
  destinationFor: (workspaceId: string) => string
): Promise<void> {
  logger.warn('No workspaces found, creating default workspace')
  try {
    const data = await requestJson(createWorkspaceContract, {
      body: { name: 'My Workspace' },
    })
    if (data.workspace?.id) {
      logger.info(`Created default workspace: ${data.workspace.id}`)
      sessionStorage.removeItem(WORKSPACE_RACE_RETRY_KEY)
      router.replace(destinationFor(data.workspace.id))
      return
    }
    logger.error('Failed to create default workspace')
  } catch (error) {
    /**
     * 409 means the caller's organization membership changed while the
     * default workspace was being created — they are still authenticated and
     * their workspaces likely exist now, so re-resolve ONCE. A second 409
     * means something other than a race, so surface the error card instead of
     * reloading forever.
     */
    if (isApiClientError(error) && error.status === 409) {
      if (sessionStorage.getItem(WORKSPACE_RACE_RETRY_KEY)) {
        logger.error('Default workspace creation kept conflicting after a retry')
        sessionStorage.removeItem(WORKSPACE_RACE_RETRY_KEY)
        onUnrecoverable()
        return
      }
      sessionStorage.setItem(WORKSPACE_RACE_RETRY_KEY, '1')
      logger.info('Default workspace creation raced an organization change; re-resolving')
      window.location.reload()
      return
    }
    logger.error('Error creating default workspace:', error)
  }
  if (isLocalLoginEnabled) {
    router.replace('/login')
    return
  }
  const resume = buildArenaSimResumeUrl(window.location.href, window.location.hostname)
  window.location.assign(resume?.href ?? ARENA_SSO_SESSION_REQUIRED_PATH)
}
