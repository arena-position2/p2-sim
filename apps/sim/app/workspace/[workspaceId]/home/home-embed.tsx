'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@sim/emcn'
import { ArrowLeft, PanelLeft } from '@sim/emcn/icons'
import { createLogger } from '@sim/logger'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { usePostHog } from 'posthog-js/react'
import type { WorkspaceSearchFilters } from '@/lib/api/contracts/knowledge'
import { useSession } from '@/lib/auth/auth-client'
import {
  LandingPromptStorage,
  type LandingWorkflowSeed,
  LandingWorkflowSeedStorage,
} from '@/lib/core/utils/browser-storage'
import { captureEvent } from '@/lib/posthog/client'
import { persistImportedWorkflow } from '@/lib/workflows/operations/import-export'
import { useMarkMothershipChatRead } from '@/hooks/queries/mothership-chats'
import { useLocalCopilotCatalogSelection } from '@/local-copilot/hooks/use-copilot-backend-preference'
import type { ChatContext } from '@/stores/panel'
import {
  ChatSurfaceProvider,
  EmbedHtmlContent,
  MothershipChat,
  MothershipResourcesProvider,
  MothershipView,
  UserInput,
} from './components'
import { getMothershipUseChatOptions, useChat, useMothershipResize } from './hooks'
import type {
  FileAttachmentForApi,
  MothershipResource,
  MothershipResourceType,
  WorkspaceResourceRef,
} from './types'

const logger = createLogger('HomeEmbed')

interface HomeEmbedProps {
  chatId?: string
  /** When set (task embed), back navigates here instead of resetting workspace embed. */
  embedBackHref?: string
}

export function HomeEmbed({ chatId, embedBackHref }: HomeEmbedProps = {}) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialResourceId = searchParams.get('resource')
  const roleParam = searchParams.get('role')
  const embedPersona = roleParam ? decodeURIComponent(roleParam) : undefined
  const { data: session } = useSession()
  const userId = session?.user?.id
  const posthog = usePostHog()
  const posthogRef = useRef(posthog)
  posthogRef.current = posthog
  const [initialPrompt, setInitialPrompt] = useState('')
  const hasCheckedLandingStorageRef = useRef(false)
  const initialViewInputRef = useRef<HTMLDivElement>(null)

  const [isInputEntering, setIsInputEntering] = useState(false)

  const createWorkflowFromLandingSeed = useCallback(
    async (seed: LandingWorkflowSeed) => {
      try {
        const result = await persistImportedWorkflow({
          content: seed.workflowJson,
          filename: `${seed.workflowName}.json`,
          workspaceId,
          nameOverride: seed.workflowName,
          descriptionOverride: seed.workflowDescription || 'Imported from landing template',
          createWorkflow: async ({ name, description, workspaceId }) => {
            const response = await fetch('/api/workflows', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                description,
                workspaceId,
                deduplicate: true,
              }),
            })

            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}))
              throw new Error(errorData.error || 'Failed to create workflow')
            }

            return response.json()
          },
        })

        if (result?.workflowId) {
          window.location.href = `/workspace/${workspaceId}/w/${result.workflowId}/embed`
          return
        }

        logger.warn('Landing workflow seed did not produce a workflow', {
          templateId: seed.templateId,
        })
      } catch (error) {
        logger.error('Error creating workflow from landing workflow seed:', error)
      }
    },
    [workspaceId]
  )

  useEffect(() => {
    if (hasCheckedLandingStorageRef.current) return
    hasCheckedLandingStorageRef.current = true

    const workflowSeed = LandingWorkflowSeedStorage.consume()
    if (workflowSeed) {
      logger.info('Retrieved landing page workflow seed, creating workflow in workspace')
      void createWorkflowFromLandingSeed(workflowSeed)
      return
    }

    const prompt = LandingPromptStorage.consume()
    if (prompt) {
      logger.info('Retrieved landing page prompt, populating home input')
      setInitialPrompt(prompt)
    }
  }, [createWorkflowFromLandingSeed])

  const wasSendingRef = useRef(false)

  const { mutate: markRead } = useMarkMothershipChatRead(workspaceId)

  const [isResourceCollapsed, setIsResourceCollapsed] = useState(true)
  const [skipResourceTransition, setSkipResourceTransition] = useState(false)
  const isResourceCollapsedRef = useRef(isResourceCollapsed)
  isResourceCollapsedRef.current = isResourceCollapsed

  const collapseResource = useCallback(() => {
    setIsResourceCollapsed(true)
  }, [])

  const setActiveResourceIdRef = useRef<(resourceId: string | null) => void>(() => {})
  const handleResourceEvent = useCallback((resourceId: string) => {
    if (isResourceCollapsedRef.current) {
      setIsResourceCollapsed(false)
    }
    setActiveResourceIdRef.current(resourceId)
  }, [])

  const {
    canSwitchBackend,
    copilotBackend,
    setCopilotBackend,
    localCopilotCatalogId,
    setLocalCopilotCatalogId,
  } = useLocalCopilotCatalogSelection()

  const {
    messages,
    isChatHistoryPending,
    isSending,
    isReconnecting,
    sendMessage,
    stopGeneration,
    resolvedChatId,
    desktopScopeId,
    resources,
    activeResourceId,
    setActiveResourceId,
    addResource,
    removeResource,
    reorderResources,
    messageQueue,
    removeFromQueue,
    sendNow,
    editQueuedMessage,
    cancelQueueEdit,
    editingQueuedId,
    dispatchingHeadId,
    previewSession,
  } = useChat(
    workspaceId,
    chatId,
    getMothershipUseChatOptions({
      onResourceEvent: handleResourceEvent,
      initialActiveResourceId: initialResourceId,
      getCopilotBackend: () => copilotBackend,
      getLocalCopilotCatalogId: () => localCopilotCatalogId,
    })
  )
  setActiveResourceIdRef.current = setActiveResourceId

  const { mothershipRef, handleResizePointerDown } = useMothershipResize(desktopScopeId, {
    userId,
    collapsed: isResourceCollapsed,
  })

  useEffect(() => {
    const url = new URL(window.location.href)
    if (activeResourceId) {
      url.searchParams.set('resource', activeResourceId)
    } else {
      url.searchParams.delete('resource')
    }
    url.hash = ''
    window.history.replaceState(null, '', url.toString())
  }, [activeResourceId])

  useEffect(() => {
    wasSendingRef.current = false
    if (resolvedChatId) {
      markRead(resolvedChatId)
    } else {
      setIsResourceCollapsed(true)
    }
  }, [resolvedChatId, markRead])

  useEffect(() => {
    if (wasSendingRef.current && !isSending && resolvedChatId) {
      markRead(resolvedChatId)
    }
    wasSendingRef.current = isSending
  }, [isSending, resolvedChatId, markRead])

  useEffect(() => {
    if (!(resources.length > 0 && isResourceCollapsedRef.current)) return
    setIsResourceCollapsed(false)
    setSkipResourceTransition(true)
    const id = requestAnimationFrame(() => setSkipResourceTransition(false))
    return () => cancelAnimationFrame(id)
  }, [resources])

  useEffect(() => {
    if (resources.length === 0 && !isResourceCollapsedRef.current) {
      collapseResource()
    }
  }, [resources, collapseResource])

  const handleStopGeneration = useCallback(() => {
    captureEvent(posthogRef.current, 'task_generation_aborted', {
      workspace_id: workspaceId,
      view: 'mothership',
    })
    void stopGeneration().catch(() => {})
  }, [stopGeneration, workspaceId])

  const handleSubmit = useCallback(
    (text: string, fileAttachments?: FileAttachmentForApi[], contexts?: ChatContext[]) => {
      const trimmed = text.trim()
      if (!trimmed && !(fileAttachments && fileAttachments.length > 0)) return

      captureEvent(posthogRef.current, 'task_message_sent', {
        workspace_id: workspaceId,
        has_attachments: !!(fileAttachments && fileAttachments.length > 0),
        has_contexts: !!(contexts && contexts.length > 0),
        is_new_task: !chatId,
      })

      if (initialViewInputRef.current) {
        setIsInputEntering(true)
      }

      sendMessage(trimmed || 'Analyze the attached file(s).', fileAttachments, contexts)
    },
    [sendMessage, workspaceId, chatId]
  )

  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<{ message: string }>).detail?.message
      if (message) sendMessage(message)
    }
    window.addEventListener('mothership-send-message', handler)
    return () => window.removeEventListener('mothership-send-message', handler)
  }, [sendMessage])

  const resolveResourceFromContext = useCallback(
    (context: ChatContext): { type: MothershipResourceType; id: string } | null => {
      switch (context.kind) {
        case 'workflow':
        case 'current_workflow':
          return context.workflowId ? { type: 'workflow', id: context.workflowId } : null
        case 'knowledge':
          return context.knowledgeId ? { type: 'knowledgebase', id: context.knowledgeId } : null
        case 'table':
          return context.tableId ? { type: 'table', id: context.tableId } : null
        case 'file':
          return context.fileId ? { type: 'file', id: context.fileId } : null
        default:
          return null
      }
    },
    []
  )

  const handleContextAdd = useCallback(
    (context: ChatContext) => {
      const resolved = resolveResourceFromContext(context)
      if (resolved) {
        addResource({ ...resolved, title: context.label })
        handleResourceEvent(resolved.id)
      }
    },
    [resolveResourceFromContext, addResource, handleResourceEvent]
  )

  const handleInitialContextRemove = useCallback(
    (context: ChatContext) => {
      const resolved = resolveResourceFromContext(context)
      if (!resolved) return
      removeResource(resolved.type, resolved.id)
    },
    [resolveResourceFromContext, removeResource]
  )

  const handleWorkspaceResourceSelect = useCallback(
    (resource: WorkspaceResourceRef) => {
      if (!resource.id) return
      const resolved: MothershipResource = {
        type: resource.type,
        id: resource.id,
        title: resource.title,
        path: resource.path,
      }
      const wasAdded = addResource(resolved)
      if (!wasAdded) {
        setActiveResourceId(resource.id)
      }
      handleResourceEvent(resource.id)
    },
    [addResource, handleResourceEvent, setActiveResourceId]
  )

  const handleSummarize = useCallback(
    (message: string, filters: WorkspaceSearchFilters) => {
      void sendMessage(message, undefined, undefined, { assistantSearch: filters })
    },
    [sendMessage]
  )

  const hasMessages = messages.length > 0
  const showChatSkeleton = Boolean(chatId) && !hasMessages && isChatHistoryPending
  const conversationId = resolvedChatId ?? chatId
  // Gate the executive-dashboard initial view behind every signal that an
  // active conversation is in flight. Previously this branch only checked
  // `hasMessages` and the `chatId` prop, which let the dashboard re-flash
  // mid-request in embed mode: when the workflow path created a new chat row
  // and `resolvedChatId` was set internally, `useMothershipChatHistory` momentarily
  // returned `{ messages: [] }` and the prop `chatId` was still undefined, so
  // both predicates were `false` and the dashboard re-mounted (which also
  // restarted the rotating placeholder via `<UserInput isInitialView>`).
  const shouldShowDashboard =
    !hasMessages && !isSending && !isReconnecting && !conversationId && !showChatSkeleton

  const isHighlightsPageShown = shouldShowDashboard

  const handleEmbedBack = useCallback(() => {
    if (embedBackHref) {
      router.push(embedBackHref)
      return
    }
    const query = searchParams.toString()
    const href = query
      ? `/workspace/${workspaceId}/embed?${query}`
      : `/workspace/${workspaceId}/embed`
    window.location.assign(href)
  }, [embedBackHref, router, searchParams, workspaceId])

  const embedBackButton = !isHighlightsPageShown ? (
    <div className='absolute top-[8.5px] left-[16px] z-30'>
      <Button
        variant='ghost'
        size={null}
        type='button'
        onClick={handleEmbedBack}
        className='h-[30px] w-[30px] rounded-[8px] hover-hover:bg-[var(--surface-active)]'
        aria-label='Back to highlights'
      >
        <ArrowLeft className='h-[16px] w-[16px] text-[var(--text-icon)]' />
      </Button>
    </div>
  ) : null

  if (shouldShowDashboard) {
    return (
      <div className='h-full overflow-y-auto bg-[var(--bg)] [scrollbar-gutter:stable_both-edges]'>
        <div className='flex flex-col items-center justify-center p-6'>
          <h1
            data-tour='home-greeting'
            className='mb-6 max-w-[42rem] text-balance font-[430] font-season text-[32px] text-[var(--text-primary)] tracking-[-0.02em]'
          >
            What should we get done
            {session?.user?.name ? `, ${session.user.name.split(' ')[0]}` : ''}?
          </h1>
          <div ref={initialViewInputRef} className='w-full' data-tour='home-chat-input'>
            <ChatSurfaceProvider
              userId={session?.user?.id}
              onContextAdd={handleContextAdd}
              onContextRemove={handleInitialContextRemove}
              canSwitchCopilotBackend={canSwitchBackend}
              copilotBackend={copilotBackend}
              setCopilotBackend={setCopilotBackend}
              localCopilotCatalogId={localCopilotCatalogId}
              setLocalCopilotCatalogId={setLocalCopilotCatalogId}
            >
              <UserInput
                defaultValue={initialPrompt}
                onSubmit={handleSubmit}
                isSending={isSending}
                onStopGeneration={handleStopGeneration}
              />
            </ChatSurfaceProvider>
          </div>
        </div>
        <EmbedHtmlContent
          persona={embedPersona}
          userId={session?.user?.id}
          email={session?.user?.email}
        />
      </div>
    )
  }

  return (
    <div className='relative flex h-full bg-[var(--bg)]'>
      {embedBackButton}
      <div className='flex h-full min-w-[320px] flex-1 flex-col'>
        <MothershipChat
          messages={messages}
          isSending={isSending}
          isReconnecting={isReconnecting}
          isLoading={showChatSkeleton}
          onSubmit={handleSubmit}
          onStopGeneration={handleStopGeneration}
          messageQueue={messageQueue}
          editingQueuedId={editingQueuedId}
          dispatchingHeadId={dispatchingHeadId}
          onRemoveQueuedMessage={removeFromQueue}
          onSendQueuedMessage={sendNow}
          onEditQueuedMessage={editQueuedMessage}
          onCancelQueueEdit={cancelQueueEdit}
          userId={session?.user?.id}
          chatId={resolvedChatId}
          onContextAdd={handleContextAdd}
          onWorkspaceResourceSelect={handleWorkspaceResourceSelect}
          canSwitchCopilotBackend={canSwitchBackend}
          copilotBackend={copilotBackend}
          setCopilotBackend={setCopilotBackend}
          localCopilotCatalogId={localCopilotCatalogId}
          setLocalCopilotCatalogId={setLocalCopilotCatalogId}
          animateInput={isInputEntering}
          onInputAnimationEnd={isInputEntering ? () => setIsInputEntering(false) : undefined}
          initialScrollBlocked={resources.length > 0 && isResourceCollapsed}
        />
      </div>

      {!isResourceCollapsed && (
        <div className='relative z-20 w-0 flex-none'>
          <div
            className='absolute inset-y-0 left-[-4px] w-[8px] cursor-ew-resize'
            role='separator'
            aria-orientation='vertical'
            aria-label='Resize resource panel'
            onPointerDown={handleResizePointerDown}
          />
        </div>
      )}

      <MothershipResourcesProvider
        selectResource={setActiveResourceId}
        addResource={addResource}
        removeResource={removeResource}
        reorderResources={reorderResources}
        collapseResource={collapseResource}
      >
        <MothershipView
          ref={mothershipRef}
          workspaceId={workspaceId}
          chatId={resolvedChatId}
          desktopScopeId={desktopScopeId}
          resources={resources}
          activeResourceId={activeResourceId}
          isCollapsed={isResourceCollapsed}
          previewSession={previewSession}
          isAgentResponding={isSending}
          onSummarize={handleSummarize}
          className={skipResourceTransition ? '!transition-none' : undefined}
        />
      </MothershipResourcesProvider>

      {isResourceCollapsed && (
        <div className='absolute top-[8.5px] right-[16px]'>
          <Button
            variant='ghost'
            size={null}
            type='button'
            onClick={() => setIsResourceCollapsed(false)}
            className='h-[30px] w-[30px] rounded-[8px] hover-hover:bg-[var(--surface-active)]'
            aria-label='Expand resource view'
          >
            <PanelLeft className='h-[16px] w-[16px] text-[var(--text-icon)]' />
          </Button>
        </div>
      )}
    </div>
  )
}
