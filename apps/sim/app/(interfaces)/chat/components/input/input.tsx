'use client'

import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  cn,
  handleKeyboardActivation,
  scrollFadeAttributes,
  scrollFadeClass,
  Tooltip,
  useScrollEdges,
} from '@sim/emcn'
import { ArrowUp, Paperclip, StopFilled, X } from '@sim/emcn/icons'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import type { SelectedGeneratedImage } from '@/lib/chat/generated-image-selection'
import { CHAT_ACCEPT_ATTRIBUTE } from '@/lib/uploads/utils/validation'
import { PublicChatActionButton } from '@/app/(interfaces)/chat/components/input/public-chat-action-button'
import {
  DEPLOYED_CHAT_CONTENT_MAX_WIDTH_CLASS,
  DEPLOYED_CHAT_INPUT_HEIGHT_CLASS,
} from '@/app/(interfaces)/chat/constants'
import { isTouchMobileViewport } from '@/hooks/use-is-mobile'

const logger = createLogger('ChatInput')

const MAX_TEXTAREA_HEIGHT = 200

interface AttachedFile {
  id: string
  name: string
  size: number
  type: string
  file: File
  dataUrl?: string
}

export const ChatInput: React.FC<{
  onSubmit?: (value: string, isVoiceInput?: boolean, files?: AttachedFile[]) => void
  isStreaming?: boolean
  onStopStreaming?: () => void
  /** @deprecated Voice UI removed; kept for call-site compat. */
  onVoiceStart?: () => void
  /** @deprecated Voice UI removed; kept for call-site compat. */
  voiceOnly?: boolean
  selectedGeneratedImages?: SelectedGeneratedImage[]
  onRemoveSelectedGeneratedImage?: (imageId: string) => void
  /** When set, this text is inserted into the input followed by a space and the input is focused; then onInsertConsumed is called */
  insertText?: string
  /** Called after insertText has been applied so the parent can clear it */
  onInsertConsumed?: () => void
  /** @deprecated Voice UI removed; kept for call-site compat. */
  sttAvailable?: boolean
  /** When true, input is positioned within the flex main column instead of fixed viewport offsets */
  embedded?: boolean
  /** Landing-page layout; deployed chrome is driven by `landing || embedded` */
  landing?: boolean
  placeholder?: string
}> = ({
  onSubmit,
  isStreaming = false,
  onStopStreaming,
  selectedGeneratedImages = [],
  onRemoveSelectedGeneratedImage,
  insertText,
  onInsertConsumed,
  embedded = false,
  landing = false,
  placeholder = 'Enter a message...',
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachmentsRef = useRef<HTMLDivElement>(null)
  const [inputValue, setInputValue] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [uploadErrors, setUploadErrors] = useState<string[]>([])
  const [dragCounter, setDragCounter] = useState(0)
  const [isMultiLineInput, setIsMultiLineInput] = useState(false)
  const isDragOver = dragCounter > 0
  const attachmentEdges = useScrollEdges(attachmentsRef, { enabled: attachedFiles.length > 0 })

  // When parent injects text (e.g. "Ask this in chat"), append it + space and focus the input.
  useEffect(() => {
    const text = insertText?.trim()
    if (!text) return

    setInputValue((prev) => {
      const prefix = prev.length > 0 ? `${prev.replace(/\s+$/, '')} ` : ''
      return `${prefix}${text} `
    })

    onInsertConsumed?.()

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        const end = el.value.length
        el.setSelectionRange(end, end)
      })
    })
  }, [insertText, onInsertConsumed])

  const useDeployedChrome = landing || embedded

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const singleLineHeight = 24
    const scrollHeight = el.scrollHeight
    const newHeight = Math.min(scrollHeight, MAX_TEXTAREA_HEIGHT)
    el.style.height = `${newHeight}px`

    if (useDeployedChrome) {
      setIsMultiLineInput(newHeight > singleLineHeight + 2 || inputValue.includes('\n'))
    }
  }, [inputValue, useDeployedChrome])

  const handleFileSelect = async (selectedFiles: FileList | null) => {
    if (!selectedFiles) return

    const newFiles: AttachedFile[] = []
    const maxSize = 10 * 1024 * 1024
    const maxFiles = 15
    const errors: string[] = []

    for (const file of Array.from(selectedFiles)) {
      if (attachedFiles.length + newFiles.length >= maxFiles) {
        errors.push(`Maximum of ${maxFiles} files allowed`)
        break
      }

      if (file.size > maxSize) {
        errors.push(`${file.name} is too large (max 10MB)`)
        continue
      }

      const isDuplicate = attachedFiles.some(
        (existing) => existing.name === file.name && existing.size === file.size
      )
      if (isDuplicate) {
        errors.push(`${file.name} already added`)
        continue
      }

      let dataUrl: string | undefined
      if (file.type.startsWith('image/')) {
        try {
          dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(file)
          })
        } catch (error) {
          logger.error('Error reading file:', error)
        }
      }

      newFiles.push({
        id: generateId(),
        name: file.name,
        size: file.size,
        type: file.type,
        file,
        dataUrl,
      })
    }

    if (newFiles.length > 0) {
      setAttachedFiles((prev) => [...prev, ...newFiles])
    }

    if (errors.length > 0) {
      setUploadErrors(errors)
    } else if (newFiles.length > 0) {
      setUploadErrors([])
    }
  }

  const handleRemoveFile = useCallback((fileId: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== fileId))
  }, [])

  const handleSubmit = useCallback(() => {
    if (isStreaming) return
    if (!inputValue.trim() && attachedFiles.length === 0 && selectedGeneratedImages.length === 0)
      return
    onSubmit?.(inputValue.trim(), false, attachedFiles)
    setInputValue('')
    setAttachedFiles([])
    setUploadErrors([])
  }, [isStreaming, inputValue, attachedFiles, onSubmit, selectedGeneratedImages.length])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.nativeEvent.isComposing &&
        !isTouchMobileViewport()
      ) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  const focusTextarea = useCallback(() => {
    textareaRef.current?.focus()
  }, [])

  const handleContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    textareaRef.current?.focus()
  }, [])

  const canSubmit =
    (inputValue.trim().length > 0 ||
      attachedFiles.length > 0 ||
      selectedGeneratedImages.length > 0) &&
    !isStreaming

  const hasDeployedExtras =
    attachedFiles.length > 0 || selectedGeneratedImages.length > 0 || isMultiLineInput

  const renderDeployedControls = () => {
    const alignControlsCenter = !isMultiLineInput
    const controlAlignClass = alignControlsCenter
      ? 'h-full min-h-0 items-center'
      : 'items-start py-1'
    const pinnedControlClass = alignControlsCenter ? undefined : 'mt-0.5'

    return (
      <div className={cn('flex w-full gap-2', controlAlignClass)}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type='button'
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming || attachedFiles.length >= 15}
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--text-icon)] transition-colors hover-hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50',
                pinnedControlClass
              )}
            >
              <Paperclip className='size-[16px]' strokeWidth={2} />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Content side='top'>
            <p>Attach files</p>
          </Tooltip.Content>
        </Tooltip.Root>

        <input
          ref={fileInputRef}
          type='file'
          multiple
          accept={CHAT_ACCEPT_ATTRIBUTE}
          onChange={(e) => {
            handleFileSelect(e.target.files)
            if (fileInputRef.current) fileInputRef.current.value = ''
          }}
          className='hidden'
          disabled={isStreaming}
        />

        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isDragOver ? 'Drop files here...' : placeholder}
          rows={1}
          className={cn(
            'm-0 min-w-0 flex-1 resize-none border-0 bg-transparent p-0 font-[family-name:var(--font-inter)] font-normal text-[var(--text-primary)] text-base leading-[23px] tracking-[0] outline-none placeholder:font-[family-name:var(--font-inter)] placeholder:font-normal placeholder:text-[var(--text-muted)] placeholder:text-base focus-visible:ring-0 focus-visible:ring-offset-0',
            isMultiLineInput
              ? 'min-h-[24px] overflow-y-auto overflow-x-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
              : 'min-h-[24px] overflow-hidden'
          )}
        />

        {isStreaming ? (
          <button
            type='button'
            onClick={onStopStreaming}
            className={cn(
              'deployed-send-button flex size-7 shrink-0 items-center justify-center rounded-full border-0 p-0 transition-colors',
              pinnedControlClass
            )}
            title='Stop generation'
          >
            <svg
              className='block size-[14px] fill-current'
              viewBox='0 0 24 24'
              xmlns='http://www.w3.org/2000/svg'
            >
              <rect x='4' y='4' width='16' height='16' rx='3' ry='3' />
            </svg>
          </button>
        ) : (
          <button
            type='button'
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={cn(
              'deployed-send-button flex size-7 shrink-0 items-center justify-center rounded-full border-0 p-0 transition-colors disabled:cursor-not-allowed',
              pinnedControlClass
            )}
            aria-label='Send message'
          >
            <ArrowUp className='block size-4' />
          </button>
        )}
      </div>
    )
  }

  return (
    <Tooltip.Provider>
      <div
        className={cn(
          'flex w-full items-center justify-center',
          useDeployedChrome
            ? 'relative w-full shrink-0 px-0 pb-0'
            : cn(
                'bg-gradient-to-t from-[var(--bg)] to-transparent px-4 pb-4 md:px-0 md:pb-4',
                'fixed right-0 bottom-0 left-0 ml-[118px]'
              )
        )}
      >
        <div ref={wrapperRef} className={`w-full ${DEPLOYED_CHAT_CONTENT_MAX_WIDTH_CLASS}`}>
          {uploadErrors.length > 0 && (
            <div className='mb-3 flex flex-col gap-2'>
              {uploadErrors.map((error, idx) => (
                <Badge key={`${error}-${idx}`} variant='red' size='lg' dot className='max-w-full'>
                  {error}
                </Badge>
              ))}
            </div>
          )}

          {/* Input container */}
          <div
            className={cn(
              'w-full',
              useDeployedChrome && 'deployed-chat-input-shell',
              useDeployedChrome && !hasDeployedExtras && DEPLOYED_CHAT_INPUT_HEIGHT_CLASS
            )}
          >
            <div
              role='group'
              aria-label='Chat message input'
              onClick={handleContainerClick}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                handleKeyboardActivation(event, focusTextarea)
              }}
              className={cn(
                'relative z-10 w-full cursor-text',
                useDeployedChrome
                  ? cn(
                      'rounded-2xl bg-transparent px-4',
                      hasDeployedExtras ? 'py-1' : 'flex h-full min-w-0 items-center py-1'
                    )
                  : 'rounded-2xl border border-[var(--border-1)] bg-white px-2.5 py-2',
                isDragOver && 'border-purple-500'
              )}
              onDragEnter={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (!isStreaming) setDragCounter((prev) => prev + 1)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (!isStreaming) e.dataTransfer.dropEffect = 'copy'
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDragCounter((prev) => Math.max(0, prev - 1))
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDragCounter(0)
                if (!isStreaming) handleFileSelect(e.dataTransfer.files)
              }}
            >
              {/* File thumbnails */}
              {selectedGeneratedImages.length > 0 && (
                <div className='mb-1.5 flex flex-wrap gap-1.5'>
                  {selectedGeneratedImages.map((image) => (
                    <Tooltip.Root key={image.id}>
                      <Tooltip.Trigger asChild>
                        <div className='group relative h-[56px] w-[56px] flex-shrink-0 cursor-pointer overflow-hidden rounded-[8px] border border-[var(--color-ds-border-default)] bg-[var(--color-ds-surface-subtle)]'>
                          <img
                            src={image.url}
                            alt={image.name}
                            className='h-full w-full object-cover'
                          />
                          {onRemoveSelectedGeneratedImage && (
                            <button
                              type='button'
                              onClick={(e) => {
                                e.stopPropagation()
                                onRemoveSelectedGeneratedImage(image.id)
                              }}
                              className='absolute top-[2px] right-[2px] flex h-[16px] w-[16px] items-center justify-center rounded-full bg-black/60 opacity-0 group-hover:opacity-100'
                            >
                              <X className='h-[10px] w-[10px] text-white' />
                            </button>
                          )}
                        </div>
                      </Tooltip.Trigger>
                      <Tooltip.Content side='top'>
                        <p className='max-w-[240px] truncate'>{image.name}</p>
                      </Tooltip.Content>
                    </Tooltip.Root>
                  ))}
                </div>
              )}

              {attachedFiles.length > 0 && (
                <div
                  ref={attachmentsRef}
                  className={cn(
                    'mb-1.5 max-md:max-h-24 max-md:overflow-y-auto max-md:overscroll-contain',
                    scrollFadeClass
                  )}
                  {...scrollFadeAttributes(attachmentEdges)}
                >
                  <div className='flex flex-wrap gap-1.5'>
                    {attachedFiles.map((file) => (
                      <Tooltip.Root key={file.id}>
                        <Tooltip.Trigger asChild>
                          <div className='group relative size-[56px] shrink-0 cursor-pointer overflow-hidden rounded-[8px] border border-[var(--border-1)] bg-[var(--surface-3)]'>
                            {file.dataUrl ? (
                              <img
                                src={file.dataUrl}
                                alt={file.name}
                                className='size-full object-cover'
                              />
                            ) : (
                              <div className='flex size-full flex-col items-center justify-center gap-0.5 text-[var(--text-muted)]'>
                                <Paperclip className='size-[18px]' />
                                <span className='max-w-[48px] truncate px-[2px] text-[9px]'>
                                  {file.name.split('.').pop()}
                                </span>
                              </div>
                            )}
                            <Button
                              variant='ghost'
                              aria-label={`Remove ${file.name}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleRemoveFile(file.id)
                              }}
                              className='absolute top-[2px] right-[2px] size-11 items-start justify-end p-0 focus-visible:opacity-100 md:pointer-fine:size-[16px] md:pointer-fine:opacity-0 md:pointer-fine:group-hover:opacity-100'
                            >
                              <span className='flex size-7 items-center justify-center rounded-full bg-black/60 text-white md:pointer-fine:size-4'>
                                <X className='size-[10px]' />
                              </span>
                            </Button>
                          </div>
                        </Tooltip.Trigger>
                        <Tooltip.Content side='top'>
                          <p className='max-w-[200px] truncate'>{file.name}</p>
                        </Tooltip.Content>
                      </Tooltip.Root>
                    ))}
                  </div>
                </div>
              )}

              {useDeployedChrome ? (
                renderDeployedControls()
              ) : (
                <>
                  <textarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isDragOver ? 'Drop files here...' : placeholder}
                    rows={1}
                    className='m-0 h-auto min-h-[24px] w-full resize-none overflow-y-auto overflow-x-hidden border-0 bg-transparent p-1 text-[15px] leading-[24px] outline-none [-ms-overflow-style:none] [scrollbar-width:none] placeholder:text-[var(--text-muted)] focus-visible:ring-0 focus-visible:ring-offset-0 [&::-webkit-scrollbar]:hidden'
                  />

                  <div className='flex items-center justify-between'>
                    <div>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <PublicChatActionButton
                            aria-label='Attach files'
                            variant='quiet'
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isStreaming || attachedFiles.length >= 15}
                          >
                            <Paperclip className='size-[16px]' />
                          </PublicChatActionButton>
                        </Tooltip.Trigger>
                        <Tooltip.Content side='top'>
                          <p>Attach files</p>
                        </Tooltip.Content>
                      </Tooltip.Root>

                      <input
                        ref={fileInputRef}
                        type='file'
                        multiple
                        accept={CHAT_ACCEPT_ATTRIBUTE}
                        onChange={(e) => {
                          handleFileSelect(e.target.files)
                          if (fileInputRef.current) fileInputRef.current.value = ''
                        }}
                        className='hidden'
                        disabled={isStreaming}
                      />
                    </div>

                    <div className='flex items-center gap-1.5'>
                      {isStreaming ? (
                        <PublicChatActionButton
                          variant='primary'
                          onClick={onStopStreaming}
                          aria-label='Stop generation'
                        >
                          <StopFilled className='block size-[14px] fill-current' />
                        </PublicChatActionButton>
                      ) : (
                        <PublicChatActionButton
                          variant='primary'
                          onClick={handleSubmit}
                          disabled={!canSubmit}
                          aria-label='Send message'
                        >
                          <ArrowUp className='block size-[16px]' />
                        </PublicChatActionButton>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </Tooltip.Provider>
  )
}
