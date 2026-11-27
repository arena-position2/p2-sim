'use client'

import type { RefObject } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Tooltip } from '@sim/emcn'
import type { SelectedGeneratedImage } from '@/lib/chat/generated-image-selection'
import { DeployedChatDescriptionModal } from '@/app/(interfaces)/chat/[identifier]/DeployedChatDescriptionModal'
import { ChatInput } from '@/app/(interfaces)/chat/components'
import { WelcomeMessageWithCtas } from '@/app/(interfaces)/chat/components/message/components/welcome-message-with-ctas'
import { DEPLOYED_CHAT_LANDING_MAX_WIDTH_CLASS } from '@/app/(interfaces)/chat/constants'
import {
  getDeployedChatFirstName,
  resolveDeployedChatLandingDescription,
} from '@/app/(interfaces)/chat/utils/clip-description'

interface DeployedChatDescriptionPreviewProps {
  text: string
  onExpand: () => void
  onWelcomeQueryClick?: (query: string) => void
}

function DeployedChatDescriptionPreview({
  text,
  onExpand,
  onWelcomeQueryClick,
}: DeployedChatDescriptionPreviewProps) {
  const descriptionRef = useRef<HTMLParagraphElement>(null)
  const [isTruncated, setIsTruncated] = useState(false)

  useLayoutEffect(() => {
    const element = descriptionRef.current
    if (!element) return

    const updateTruncation = () => {
      setIsTruncated(element.scrollHeight > element.clientHeight + 1)
    }

    updateTruncation()

    const resizeObserver = new ResizeObserver(updateTruncation)
    resizeObserver.observe(element)
    return () => resizeObserver.disconnect()
  }, [text])

  return (
    <div className='relative mt-3'>
      <p
        ref={descriptionRef}
        className='max-h-[3.2em] overflow-hidden whitespace-pre-wrap break-words text-center text-[var(--text-muted)] text-sm leading-[21px]'
      >
        <WelcomeMessageWithCtas
          content={text}
          variant='landing'
          onQueryClick={onWelcomeQueryClick}
        />
      </p>
      {isTruncated && (
        <Tooltip.Provider>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type='button'
                onClick={onExpand}
                className='absolute right-0 bottom-0 bg-linear-to-r from-transparent via-[var(--bg)] to-[var(--bg)] pl-3 text-[var(--text-muted)] text-sm leading-[21px] hover:text-[var(--text-primary)]'
                aria-label='View full description'
              >
                ...
              </button>
            </Tooltip.Trigger>
            <Tooltip.Content side='top'>View full description</Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
      )}
    </div>
  )
}

interface DeployedChatLandingProps {
  chatConfig?: {
    title: string
    description?: string
    customizations?: {
      headerText?: string
      welcomeMessage?: string
    }
  } | null
  department?: string | null
  userName?: string | null
  isStreaming?: boolean
  isLoading?: boolean
  insertText?: string
  onInsertConsumed?: () => void
  onSubmit: (
    value: string,
    isVoiceInput?: boolean,
    files?: Array<{
      id: string
      name: string
      size: number
      type: string
      file: File
      dataUrl?: string
    }>
  ) => void
  onStopStreaming?: () => void
  onVoiceStart?: () => void
  selectedGeneratedImages?: SelectedGeneratedImage[]
  onRemoveSelectedGeneratedImage?: (imageId: string) => void
  inputWrapperRef?: RefObject<HTMLDivElement | null>
  /** When set, `{{query}}` tokens in the welcome message submit that query */
  onWelcomeQueryClick?: (query: string) => void
}

export function DeployedChatLanding({
  chatConfig,
  department,
  userName,
  isStreaming = false,
  isLoading = false,
  insertText,
  onInsertConsumed,
  onSubmit,
  onStopStreaming,
  onVoiceStart,
  selectedGeneratedImages,
  onRemoveSelectedGeneratedImage,
  inputWrapperRef,
  onWelcomeQueryClick,
}: DeployedChatLandingProps) {
  const [isDescriptionModalOpen, setIsDescriptionModalOpen] = useState(false)

  const title = chatConfig?.customizations?.headerText || chatConfig?.title || 'Chat'
  const firstName = getDeployedChatFirstName(userName)
  const descriptionSource = resolveDeployedChatLandingDescription({
    title,
    welcomeMessage: chatConfig?.customizations?.welcomeMessage,
  })

  const promptLine = `What should we get done${firstName ? `, ${firstName}` : ''}?`

  const handleWelcomeQueryClick = (query: string) => {
    setIsDescriptionModalOpen(false)
    onWelcomeQueryClick?.(query)
  }

  return (
    <>
      <div className='flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]'>
        <div className='flex flex-1 flex-col items-center justify-center px-4 py-8 md:px-6'>
          <div
            className={`flex w-full flex-col gap-6 ${DEPLOYED_CHAT_LANDING_MAX_WIDTH_CLASS} text-center`}
          >
            <div>
              <h1 className='text-[24px] text-[var(--text-primary)] leading-[32px]'>{title}</h1>

              {descriptionSource && (
                <DeployedChatDescriptionPreview
                  text={descriptionSource}
                  onExpand={() => setIsDescriptionModalOpen(true)}
                  onWelcomeQueryClick={handleWelcomeQueryClick}
                />
              )}
            </div>

            <p className='text-[20px] text-[var(--text-primary)] leading-[28px]'>{promptLine}</p>

            <div ref={inputWrapperRef} className='w-full'>
              <ChatInput
                embedded
                landing
                insertText={insertText}
                onInsertConsumed={onInsertConsumed}
                onSubmit={onSubmit}
                isStreaming={isLoading || isStreaming}
                onStopStreaming={onStopStreaming}
                onVoiceStart={onVoiceStart}
                selectedGeneratedImages={selectedGeneratedImages}
                onRemoveSelectedGeneratedImage={onRemoveSelectedGeneratedImage}
              />
            </div>
          </div>
        </div>
      </div>

      <DeployedChatDescriptionModal
        open={isDescriptionModalOpen}
        onOpenChange={setIsDescriptionModalOpen}
        title={title}
        description={descriptionSource}
        department={department}
        onWelcomeQueryClick={handleWelcomeQueryClick}
      />
    </>
  )
}
