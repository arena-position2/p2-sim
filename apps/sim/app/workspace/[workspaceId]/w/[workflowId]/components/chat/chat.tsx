'use client'

import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Badge,
  Button,
  ComposerActionButton,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverItem,
  PopoverScrollArea,
  PopoverTrigger,
  scrollFadeAttributes,
  scrollFadeClass,
  Tooltip,
  Trash,
  useScrollEdges,
} from '@sim/emcn'
import { CircleAlert, Download } from '@sim/emcn/icons'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import { ArrowUp, MoreVertical, Paperclip, Square, X } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'
import { useSession } from '@/lib/auth/auth-client'
import {
  formatChartDeployOutputForChat,
  hasRenderableChartDeployOutput,
} from '@/lib/chart-generation/echarts-option'
import { resolveChartContentFromFinalOutput } from '@/lib/chart-generation/resolve-final-output-chart'
import {
  extractAssistantFilesFromData,
  extractGeneratedImagesFromData,
} from '@/lib/chat/assistant-assets'
import { useGeneratedImageReuse } from '@/lib/chat/use-generated-image-reuse'
import {
  extractBlockIdFromOutputId,
  extractPathFromOutputId,
  parseOutputContentSafely,
} from '@/lib/core/utils/response-format'
import { readSSEEvents } from '@/lib/core/utils/sse'
import { CHAT_ACCEPT_ATTRIBUTE } from '@/lib/uploads/utils/validation'
import { getCustomInputFields, normalizeInputFormatValue } from '@/lib/workflows/input-format'
import { StartBlockPath, TriggerUtils } from '@/lib/workflows/triggers/triggers'
import { type InputFormatField, START_BLOCK_RESERVED_FIELDS } from '@/lib/workflows/types'
import {
  workflowChatAddInputEvent,
  workflowChatMsgSentEvent,
} from '@/app/arenaMixpanelEvents/mixpanelEvents'
import type { ChatMessageAttachment } from '@/app/workspace/[workspaceId]/home/types'
import {
  ChatMessage,
  OutputSelect,
  StartBlockInputModal,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components'
import {
  type ChatFile,
  MAX_CHAT_FILES,
  useChatFileUpload,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/hooks'
import {
  usePreventZoom,
  useScrollManagement,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/hooks'
import {
  useFloatBoundarySync,
  useFloatDrag,
  useFloatLayout,
  useFloatResize,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/hooks/float'
import {
  isChatWorkflowRunResult,
  useWorkflowExecution,
  WorkflowAttachmentUploadError,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/hooks/use-workflow-execution'
import type { UploadedWorkflowAttachment } from '@/app/workspace/[workspaceId]/w/[workflowId]/utils/workflow-attachment-upload'
import type { BlockLog, ExecutionResult } from '@/executor/types'
import { useWorkspaceSettings } from '@/hooks/queries/workspace'
import { isMobileViewport, useIsMobile } from '@/hooks/use-is-mobile'
import { useChatStore } from '@/stores/chat/store'
import { getChatPosition } from '@/stores/chat/utils'
import { useIsCurrentWorkflowExecuting } from '@/stores/execution'
import { useOperationQueue } from '@/stores/operation-queue/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'

const logger = createLogger('FloatingChat')

/**
 * Formats file size in human-readable format
 * @param bytes - Size in bytes
 * @returns Formatted string with appropriate unit (B, KB, MB, GB)
 */
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${Math.round((bytes / 1024 ** i) * 10) / 10} ${units[i]}`
}

function toChatMessageAttachments(
  uploadedAttachments: UploadedWorkflowAttachment[]
): ChatMessageAttachment[] {
  return uploadedAttachments.map((file) => {
    const supportsPreview = file.type.startsWith('image/') || file.type.startsWith('video/')
    return {
      id: file.id,
      filename: file.name,
      media_type: file.type,
      size: file.size,
      ...(supportsPreview ? { previewUrl: file.url } : {}),
    }
  })
}

interface ChatFilePreviewProps {
  file: ChatFile
  onRemove: (fileId: string) => void
}

/**
 * Uses a short-lived object URL only while an image remains in the composer.
 * Successful uploads replace it with the storage-backed URL in message history.
 */
function ChatFilePreview({ file, onRemove }: ChatFilePreviewProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!file.type.startsWith('image/')) return

    const objectUrl = URL.createObjectURL(file.file)
    setPreviewUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file.file, file.type])

  return (
    <div
      className={cn(
        'group relative pointer-coarse:flex shrink-0 pointer-coarse:items-center overflow-hidden rounded-md bg-[var(--surface-2)]',
        previewUrl
          ? 'size-[40px] pointer-coarse:h-12 pointer-coarse:w-auto'
          : 'flex pointer-coarse:min-h-12 min-w-[80px] max-w-[120px] items-center justify-center px-2 py-0.5'
      )}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className='pointer-coarse:size-12 size-full pointer-coarse:shrink-0 object-cover'
        />
      ) : (
        <div className='min-w-0 flex-1'>
          <div className='truncate font-medium text-[var(--text-body)] text-micro'>{file.name}</div>
          <div className='text-[9px] text-[var(--text-tertiary)]'>{formatFileSize(file.size)}</div>
        </div>
      )}

      <Button
        aria-label='Remove file'
        variant='ghost'
        size='icon'
        onClick={(event) => {
          event.stopPropagation()
          onRemove(file.id)
        }}
        className='pointer-coarse:static absolute top-0.5 right-0.5 pointer-coarse:size-11 pointer-coarse:shrink-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 md:pointer-fine:opacity-0'
      >
        <span
          className={cn(
            'flex items-center justify-center',
            previewUrl &&
              'size-4 rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-body)]'
          )}
        >
          <X className='size-2.5' />
        </span>
      </Button>
    </div>
  )
}

/**
 * Extracts output value from logs based on output ID
 * @param logs - Array of block logs from workflow execution
 * @param outputId - Output identifier in format blockId or blockId.path
 * @returns Extracted output value or undefined if not found
 */
const extractOutputFromLogs = (logs: BlockLog[] | undefined, outputId: string): unknown => {
  const blockId = extractBlockIdFromOutputId(outputId)
  const path = extractPathFromOutputId(outputId, blockId)
  const log = logs?.find((l) => l.blockId === blockId)

  if (!log) return undefined

  let output = log.output

  if (path) {
    output = parseOutputContentSafely(output)
    const pathParts = path.split('.')
    let current = output
    for (const part of pathParts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part]
      } else {
        return undefined
      }
    }
    return current
  }

  return output
}

/**
 * Formats output content for display in chat
 * @param output - Output value to format (string, object, or other)
 * @returns Formatted string, markdown code block for objects, or empty string
 */
const formatOutputContent = (output: unknown): string => {
  const chartContent = formatChartDeployOutputForChat(output)
  if (chartContent) {
    return chartContent
  }
  if (typeof output === 'string') {
    return output
  }
  if (output && typeof output === 'object') {
    return `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``
  }
  return ''
}

/**
 * Normalizes chart output from the streaming `final` event so the floating chat
 * renders ECharts like the deployed chat. Returns the formatted chart string, or
 * null when no renderable chart is present (leaving the streamed text untouched).
 *
 * Delegates to the shared, shape-agnostic resolver so charts are recovered
 * whether the `final` output is keyed by block id or is the workflow's
 * aggregated terminal output (which carries top-level `charts`/`content`).
 */
const resolveStreamedChartContent = (
  output: Record<string, unknown> | null,
  selectedOutputs: string[]
): string | null => resolveChartContentFromFinalOutput(output, selectedOutputs)

/**
 * Represents a field in the start block's input format configuration
 */
interface StartInputFormatField {
  id?: string
  name?: string
  type?: string
  value?: unknown
  collapsed?: boolean
}

/**
 * Floating chat modal component
 *
 * A draggable chat interface positioned over the workflow canvas that allows users to:
 * - Send messages and execute workflows
 * - Upload and attach files
 * - View streaming responses
 * - Select workflow outputs as context
 *
 * The modal is constrained by sidebar, panel, and terminal dimensions and persists
 * position across sessions using the floating chat store.
 */
export function Chat() {
  const params = useParams()
  const workspaceId = params.workspaceId as string
  const isMobile = useIsMobile()
  const activeWorkflowId = useWorkflowRegistry((s) => s.activeWorkflowId)
  const blocks = useWorkflowStore((state) => state.blocks)
  const triggerWorkflowUpdate = useWorkflowStore((state) => state.triggerUpdate)
  const setSubBlockValue = useSubBlockStore((state) => state.setValue)
  const { data: workspaceData } = useWorkspaceSettings(workspaceId)
  // API returns { workspace: { name, ... } }, and hook returns { settings, permissions }
  const workspaceName = workspaceData?.settings?.workspace?.name || 'Unknown Workspace'

  const {
    isChatOpen,
    chatPosition,
    chatWidth,
    chatHeight,
    setIsChatOpen,
    setChatPosition,
    setChatDimensions,
    messages,
    addMessage,
    selectedWorkflowOutputs,
    setSelectedWorkflowOutput,
    appendMessageContent,
    setMessageContent,
    finalizeMessageStream,
    getConversationId,
    clearChat,
    exportChatCSV,
  } = useChatStore(
    useShallow((s) => ({
      isChatOpen: s.isChatOpen,
      chatPosition: s.chatPosition,
      chatWidth: s.chatWidth,
      chatHeight: s.chatHeight,
      setIsChatOpen: s.setIsChatOpen,
      setChatPosition: s.setChatPosition,
      setChatDimensions: s.setChatDimensions,
      messages: s.messages,
      addMessage: s.addMessage,
      selectedWorkflowOutputs: s.selectedWorkflowOutputs,
      setSelectedWorkflowOutput: s.setSelectedWorkflowOutput,
      appendMessageContent: s.appendMessageContent,
      setMessageContent: s.setMessageContent,
      finalizeMessageStream: s.finalizeMessageStream,
      getConversationId: s.getConversationId,
      clearChat: s.clearChat,
      exportChatCSV: s.exportChatCSV,
    }))
  )

  const promptHistory = useChatStore(
    useShallow((state) =>
      !activeWorkflowId
        ? []
        : state.messages
            .filter((message) => message.workflowId === activeWorkflowId && message.type === 'user')
            .map((message) => message.content)
            .filter((content): content is string => typeof content === 'string')
    )
  )

  const isExecuting = useIsCurrentWorkflowExecuting()
  const { handleRunWorkflow, handleCancelExecution } = useWorkflowExecution()
  const { data: session } = useSession()
  const { addToQueue } = useOperationQueue()

  const [chatMessage, setChatMessage] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [isInputModalOpen, setIsInputModalOpen] = useState(false)
  const [startBlockInputs, setStartBlockInputs] = useState<Record<string, unknown>>({})
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const attachmentsRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const hasShownModalRef = useRef<boolean>(false)
  const hasCheckedModalRef = useRef<boolean>(false)
  const streamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const preventZoomRef = usePreventZoom()

  const {
    chatFiles,
    uploadErrors,
    isDragOver,
    removeFile,
    reportUploadError,
    clearFiles,
    clearErrors,
    handleFileInputChange,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useChatFileUpload()
  const attachmentEdges = useScrollEdges(attachmentsRef, {
    enabled: isChatOpen && chatFiles.length > 0,
  })

  /**
   * Resolves the unified start block for chat execution, if available.
   */
  const startBlockCandidate = useMemo(() => {
    if (!activeWorkflowId) {
      return null
    }

    if (!blocks || Object.keys(blocks).length === 0) {
      return null
    }

    const candidate = TriggerUtils.findStartBlock(blocks, 'chat')
    if (!candidate || candidate.path !== StartBlockPath.UNIFIED) {
      return null
    }

    return candidate
  }, [activeWorkflowId, blocks])

  const startBlockId = startBlockCandidate?.blockId ?? null

  const startBlockInputFormat = useSubBlockStore((state) => {
    if (!activeWorkflowId || !startBlockId) {
      return null
    }

    const workflowValues = state.workflowValues[activeWorkflowId]
    const fromStore = workflowValues?.[startBlockId]?.inputFormat
    if (fromStore !== undefined && fromStore !== null) {
      return fromStore
    }

    const startBlock = blocks[startBlockId]
    return startBlock?.subBlocks?.inputFormat?.value ?? null
  })

  const missingStartReservedFields = useMemo(() => {
    if (!startBlockId) {
      return START_BLOCK_RESERVED_FIELDS
    }

    const normalizedFields = normalizeInputFormatValue(startBlockInputFormat)
    const existingNames = new Set(
      normalizedFields
        .map((field) => field.name)
        .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim().toLowerCase())
    )

    return START_BLOCK_RESERVED_FIELDS.filter(
      (fieldName) => !existingNames.has(fieldName.toLowerCase())
    )
  }, [startBlockId, startBlockInputFormat])

  const shouldShowConfigureStartInputsButton =
    Boolean(startBlockId) && missingStartReservedFields.length > 0

  const { isFloatingLayout, updatePosition, updateDimensions } = useFloatLayout({
    ref: preventZoomRef,
    onPositionChange: setChatPosition,
    onDimensionsChange: setChatDimensions,
  })

  const actualPosition = getChatPosition(chatPosition, chatWidth, chatHeight)

  const { handleMouseDown } = useFloatDrag({
    position: actualPosition,
    width: chatWidth,
    height: chatHeight,
    onPositionChange: updatePosition,
  })

  useFloatBoundarySync({
    isOpen: isChatOpen && !isMobile,
    position: actualPosition,
    width: chatWidth,
    height: chatHeight,
    onPositionChange: updatePosition,
  })

  const {
    cursor: resizeCursor,
    handleMouseMove: handleResizeMouseMove,
    handleMouseLeave: handleResizeMouseLeave,
    handleMouseDown: handleResizeMouseDown,
  } = useFloatResize({
    position: actualPosition,
    width: chatWidth,
    height: chatHeight,
    onPositionChange: updatePosition,
    onDimensionsChange: updateDimensions,
  })

  const workflowMessages = useMemo(() => {
    if (!activeWorkflowId) return []
    return messages.filter((msg) => msg.workflowId === activeWorkflowId)
  }, [messages, activeWorkflowId])

  const {
    selectedGeneratedImages,
    effectiveGeneratedImages,
    selectedGeneratedImageIds,
    toggleGeneratedImageSelection,
    removeSelectedGeneratedImage,
    clearSelectedGeneratedImages,
    materializeSelectedGeneratedImages,
  } = useGeneratedImageReuse(workflowMessages)

  const isStreaming = useMemo(() => {
    const lastMessage = workflowMessages[workflowMessages.length - 1]
    return Boolean(lastMessage?.isStreaming)
  }, [workflowMessages])

  // Get custom fields (excluding reserved fields: input, conversationId, files)
  const customFields = useMemo(() => {
    return getCustomInputFields(startBlockInputFormat as InputFormatField[])
  }, [startBlockInputFormat])

  // Reset modal flags when workflow changes or messages are added
  useEffect(() => {
    if (workflowMessages.length > 0) {
      hasShownModalRef.current = false
      hasCheckedModalRef.current = false
    }
  }, [workflowMessages.length, activeWorkflowId])

  // Reset check flag when chat closes
  useEffect(() => {
    if (!isChatOpen) {
      hasCheckedModalRef.current = false
    }
  }, [isChatOpen])

  // Show modal on load if no history and there are custom fields
  // Only check once when chat opens to prevent infinite loops
  useEffect(() => {
    // Only check once per chat session when chat opens
    if (isChatOpen && !hasCheckedModalRef.current && workflowMessages.length === 0) {
      hasCheckedModalRef.current = true

      // Check if we have custom fields (check once, don't depend on it)
      if (customFields.length > 0 && !hasShownModalRef.current) {
        hasShownModalRef.current = true
        setIsInputModalOpen(true)
      }
    }
  }, [isChatOpen, workflowMessages.length, customFields.length])

  // Map chat messages to copilot message format (type -> role) for scroll hook
  const messagesForScrollHook = useMemo(() => {
    return workflowMessages.map((msg) => ({
      ...msg,
      role: msg.type,
    }))
  }, [workflowMessages])

  const { scrollAreaRef, scrollToBottom } = useScrollManagement(
    messagesForScrollHook,
    isStreaming,
    {
      behavior: 'auto',
    }
  )

  const handleToggleUserAttachmentImageSelection = useCallback(
    (messageId: string, attachment: ChatMessageAttachment) => {
      if (!attachment.previewUrl || !attachment.media_type.startsWith('image/')) {
        return
      }

      toggleGeneratedImageSelection(messageId, {
        id: attachment.id,
        name: attachment.filename,
        url: attachment.previewUrl,
        type: attachment.media_type,
      })
    },
    [toggleGeneratedImageSelection]
  )

  useEffect(() => {
    setHistoryIndex(-1)
  }, [activeWorkflowId, promptHistory])

  useEffect(() => {
    if (workflowMessages.length > 0 && isChatOpen) {
      scrollToBottom()
    }
  }, [workflowMessages.length, scrollToBottom, isChatOpen])

  const selectedOutputs = useMemo(() => {
    if (!activeWorkflowId) return []
    const selected = selectedWorkflowOutputs[activeWorkflowId]
    return selected && selected.length > 0 ? [...new Set(selected)] : []
  }, [selectedWorkflowOutputs, activeWorkflowId])

  const focusInput = useCallback((delay = 0) => {
    timeoutRef.current && clearTimeout(timeoutRef.current)

    timeoutRef.current = setTimeout(() => {
      if (!isMobileViewport() && inputRef.current && document.contains(inputRef.current)) {
        inputRef.current.focus({ preventScroll: true })
      }
    }, delay)
  }, [])

  useEffect(() => {
    return () => {
      timeoutRef.current && clearTimeout(timeoutRef.current)
      streamReaderRef.current?.cancel()
    }
  }, [])

  const handleStopStreaming = useCallback(() => {
    streamReaderRef.current?.cancel()
    streamReaderRef.current = null
    handleCancelExecution()
  }, [handleCancelExecution])

  const processStreamingResponse = useCallback(
    async (stream: ReadableStream<Uint8Array>, responseMessageId: string) => {
      const reader = stream.getReader()
      streamReaderRef.current = reader

      /**
       * Answer text tracked per block so a `chunk_reset` frame (a live-streamed
       * turn resolved to tool calls) can drop one block's contribution. Each
       * flush replaces the message content with the joined segments.
       */
      const blockOrder: string[] = []
      const blockSegments = new Map<string, string>()
      let accumulatedContent = ''
      const recomputeContent = () => {
        accumulatedContent = blockOrder.map((id) => blockSegments.get(id) ?? '').join('')
      }

      const BATCH_MAX_MS = 50
      let contentDirty = false
      let batchRAF: number | null = null
      let batchTimer: ReturnType<typeof setTimeout> | null = null
      let lastFlush = 0

      const flushChunks = () => {
        if (batchRAF !== null) {
          cancelAnimationFrame(batchRAF)
          batchRAF = null
        }
        if (batchTimer !== null) {
          clearTimeout(batchTimer)
          batchTimer = null
        }
        if (contentDirty) {
          setMessageContent(responseMessageId, accumulatedContent)
          contentDirty = false
        }
        lastFlush = performance.now()
      }

      const scheduleFlush = () => {
        if (batchRAF !== null) return
        const elapsed = performance.now() - lastFlush
        if (elapsed >= BATCH_MAX_MS) {
          flushChunks()
          return
        }
        batchRAF = requestAnimationFrame(flushChunks)
        if (batchTimer === null) {
          batchTimer = setTimeout(flushChunks, Math.max(0, BATCH_MAX_MS - elapsed))
        }
      }

      let finalError: string | null = null
      let finalOutput: Record<string, unknown> | null = null
      try {
        await readSSEEvents<{
          event?: string
          data?: ExecutionResult
          chunk?: string
          blockId?: string
        }>(reader, {
          onParseError: (_data, e) => {
            logger.error('Error parsing stream data:', e)
          },
          onEvent: (json) => {
            const { event, data: eventData, chunk: contentChunk, blockId } = json

            if (event === 'final' && eventData) {
              if ('success' in eventData && !eventData.success) {
                finalError = eventData.error || 'Workflow execution failed'
              }
              if (
                'output' in eventData &&
                eventData.output &&
                typeof eventData.output === 'object'
              ) {
                finalOutput = eventData.output as Record<string, unknown>
              }
              return true
            }

            if (event === 'chunk_reset' && blockId) {
              // Drop the block's provisional text and its order slot — the
              // final turn re-registers at the end, keeping render order =
              // arrival order (separators are recomputed on re-stream).
              if (blockSegments.has(blockId)) {
                blockSegments.delete(blockId)
                const orderIndex = blockOrder.indexOf(blockId)
                if (orderIndex !== -1) {
                  blockOrder.splice(orderIndex, 1)
                }
                recomputeContent()
                contentDirty = true
                scheduleFlush()
              }
              return
            }

            if (contentChunk) {
              const segmentKey = blockId ?? ''
              if (!blockSegments.has(segmentKey)) {
                blockOrder.push(segmentKey)
                blockSegments.set(segmentKey, '')
              }
              blockSegments.set(segmentKey, blockSegments.get(segmentKey)! + contentChunk)
              recomputeContent()
              contentDirty = true
              scheduleFlush()
            }
          },
        })
        flushChunks()
        if (finalError) {
          appendMessageContent(
            responseMessageId,
            `${accumulatedContent ? '\n\n' : ''}Error: ${finalError}`
          )
          finalizeMessageStream(responseMessageId)
        } else {
          const chartContent = resolveStreamedChartContent(finalOutput, selectedOutputs)
          if (chartContent) {
            const streamedText = accumulatedContent.trim()
            // When the streamed answer already renders a chart (standalone Chart
            // Generator block), replace it with the resolved chart. When there is
            // separate answer text without a chart (Agent block that called Chart
            // Generator as a tool), keep the text and append the chart below it.
            const finalContent =
              !streamedText || hasRenderableChartDeployOutput(streamedText)
                ? chartContent
                : `${streamedText}\n\n${chartContent}`
            finalizeMessageStream(responseMessageId, finalContent)
          } else {
            finalizeMessageStream(responseMessageId)
          }
        }
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') {
          logger.error('Error processing stream:', error)
        }
        flushChunks()
        finalizeMessageStream(responseMessageId)
      } finally {
        if (batchRAF !== null) cancelAnimationFrame(batchRAF)
        if (batchTimer !== null) clearTimeout(batchTimer)
        if (streamReaderRef.current === reader) {
          streamReaderRef.current = null
        }
        try {
          reader.releaseLock()
        } catch {}
        focusInput(100)
      }
    },
    [
      appendMessageContent,
      setMessageContent,
      finalizeMessageStream,
      focusInput,
      selectedOutputs,
      activeWorkflowId,
    ]
  )

  const handleWorkflowResponse = useCallback(
    (result: unknown) => {
      if (!result || !activeWorkflowId) return
      if (typeof result !== 'object') return

      if ('stream' in result && result.stream instanceof ReadableStream) {
        const responseMessageId = generateId()
        addMessage({
          id: responseMessageId,
          content: '',
          workflowId: activeWorkflowId,
          type: 'workflow',
          isStreaming: true,
        })
        processStreamingResponse(result.stream, responseMessageId)
        return
      }

      if ('success' in result && result.success && 'logs' in result && Array.isArray(result.logs)) {
        selectedOutputs
          .map((outputId) => extractOutputFromLogs(result.logs as BlockLog[], outputId))
          .filter((output) => output !== undefined)
          .forEach((output) => {
            const content = formatOutputContent(output)
            const files = extractAssistantFilesFromData(output)
            const generatedImages = extractGeneratedImagesFromData(output)
            if (content || files.length > 0 || generatedImages.length > 0) {
              const imageUrls = generatedImages.map((image) => image.url)
              addMessage({
                content:
                  imageUrls.length > 0
                    ? { content, image: imageUrls[0] ?? '', images: imageUrls }
                    : content || '',
                workflowId: activeWorkflowId,
                type: 'workflow',
                ...(files.length > 0 ? { files } : {}),
                ...(generatedImages.length > 0 ? { generatedImages } : {}),
              })
            }
          })
        return
      }

      if ('success' in result && !result.success) {
        const errorMessage =
          'error' in result && typeof result.error === 'string'
            ? result.error
            : 'Workflow execution failed.'
        addMessage({
          content: `Error: ${errorMessage}`,
          workflowId: activeWorkflowId,
          type: 'workflow',
        })
      }
    },
    [activeWorkflowId, selectedOutputs, addMessage, processStreamingResponse]
  )

  const buildCompleteWorkflowInput = useCallback(
    (
      userInput: string,
      conversationId: string,
      files?: Array<{
        id?: string
        name: string
        size: number
        type: string
        file: File
        dataUrl?: string
        url?: string
      }>,
      overrideValues?: Record<string, unknown>
    ) => {
      const normalizedFields = normalizeInputFormatValue(startBlockInputFormat)
      const completeInput: Record<string, unknown> = {}

      // Read values from Start Block inputFormat field values (field.value)
      // This ensures values persist and are used naturally in execution flow
      for (const field of normalizedFields) {
        const fieldName = field.name?.trim()
        if (fieldName) {
          // Priority: overrideValues (temporary) > field.value (persisted) > startBlockInputs (state) > empty string
          if (overrideValues && fieldName in overrideValues) {
            completeInput[fieldName] = overrideValues[fieldName] ?? ''
          } else if (field.value !== undefined && field.value !== null) {
            // Use the value from Start Block inputFormat field (persisted value)
            completeInput[fieldName] = field.value
          } else {
            // Fallback to state or empty string
            completeInput[fieldName] = startBlockInputs[fieldName] ?? ''
          }
        }
      }

      // Override with actual values for reserved fields
      completeInput.input = userInput
      completeInput.conversationId = conversationId

      // Handle files - only include if present, otherwise don't set it
      if (files && files.length > 0) {
        completeInput.files = files
      }

      return completeInput
    },
    [startBlockInputFormat, startBlockInputs]
  )

  /**
   * Sends a chat message and executes the workflow.
   * Processes file attachments, adds the user message to the chat,
   * and triggers workflow execution with the message as input.
   */
  const handleSendMessage = useCallback(async () => {
    if (
      (!chatMessage.trim() && chatFiles.length === 0 && effectiveGeneratedImages.length === 0) ||
      !activeWorkflowId ||
      isExecuting
    ) {
      return
    }

    const sentMessage = chatMessage.trim()
    const conversationId = getConversationId(activeWorkflowId)

    clearErrors()

    try {
      const selectedImageFiles = await materializeSelectedGeneratedImages()
      const combinedChatFiles = [
        ...chatFiles,
        ...selectedImageFiles.map((image) => ({
          id: image.id,
          name: image.name,
          size: image.size,
          type: image.type,
          file: image.file,
          dataUrl: image.dataUrl,
          url: image.url,
        })),
      ]

      workflowChatMsgSentEvent({
        'Message Content': sentMessage,
        'Message Type':
          combinedChatFiles.length > 0 && sentMessage
            ? 'Text + Attachment'
            : combinedChatFiles.length > 0 && !sentMessage
              ? 'Attachment'
              : 'Text',
        'Message ID': conversationId,
        'Workspace Name': workspaceName,
        'Workspace ID': workspaceId,
      })

      const fileArray =
        combinedChatFiles.length > 0
          ? combinedChatFiles.map((chatFile: ChatFile) => ({
              name: chatFile.name,
              size: chatFile.size,
              type: chatFile.type,
              file: chatFile.file,
              id: chatFile.id,
              dataUrl: chatFile.dataUrl,
              url: chatFile.url,
            }))
          : undefined

      const workflowInput = buildCompleteWorkflowInput(sentMessage, conversationId, fileArray)

      const result = await handleRunWorkflow(workflowInput)
      if (!isChatWorkflowRunResult(result)) {
        focusInput(10)
        return
      }
      const messageAttachments = toChatMessageAttachments(result.uploadedAttachments)

      setHistoryIndex(-1)

      const messageContent =
        sentMessage ||
        (combinedChatFiles.length > 0 ? `Uploaded ${combinedChatFiles.length} file(s)` : '')
      addMessage({
        content: messageContent,
        workflowId: activeWorkflowId,
        type: 'user',
        attachments: messageAttachments,
      })

      setChatMessage('')
      clearFiles()
      clearSelectedGeneratedImages()
      clearErrors()
      focusInput(10)

      handleWorkflowResponse(result)
    } catch (error) {
      if (error instanceof WorkflowAttachmentUploadError) {
        reportUploadError(error.message)
      } else {
        logger.error('Error in handleSendMessage:', error)
      }
      focusInput(10)
      return
    }

    focusInput(100)
  }, [
    chatMessage,
    chatFiles,
    effectiveGeneratedImages,
    activeWorkflowId,
    isExecuting,
    getConversationId,
    addMessage,
    handleRunWorkflow,
    handleWorkflowResponse,
    focusInput,
    reportUploadError,
    clearFiles,
    clearErrors,
    buildCompleteWorkflowInput,
    clearSelectedGeneratedImages,
    materializeSelectedGeneratedImages,
    workspaceName,
    workspaceId,
  ])

  const handleStartBlockInputsSubmit = useCallback(
    async (values: Record<string, unknown>) => {
      if (!activeWorkflowId || isExecuting || !startBlockId) return

      setStartBlockInputs(values)
      setIsInputModalOpen(false)

      let updatedFields: InputFormatField[] = []
      try {
        const normalizedFields = normalizeInputFormatValue(startBlockInputFormat)
        updatedFields = normalizedFields.map((field) => {
          const fieldName = field.name?.trim()
          if (fieldName && fieldName in values) {
            return {
              ...field,
              value: values[fieldName] ?? '',
            }
          }
          return field
        })

        setSubBlockValue(startBlockId, 'inputFormat', updatedFields)

        const userId = session?.user?.id || 'unknown'
        addToQueue({
          id: generateId(),
          operation: {
            operation: 'subblock-update',
            target: 'subblock',
            payload: {
              blockId: startBlockId,
              subblockId: 'inputFormat',
              value: updatedFields,
            },
          },
          workflowId: activeWorkflowId,
          userId,
        })

        triggerWorkflowUpdate()
      } catch (error) {
        logger.error('Error updating Start Block inputFormat values:', error)
        updatedFields = normalizeInputFormatValue(startBlockInputFormat)
      }

      const conversationId = getConversationId(activeWorkflowId)
      const completeInput: Record<string, unknown> = {}
      for (const field of updatedFields) {
        const fieldName = field.name?.trim()
        if (fieldName) {
          completeInput[fieldName] =
            field.value !== undefined && field.value !== null ? field.value : ''
        }
      }

      completeInput.input = ''
      completeInput.conversationId = conversationId

      try {
        const result = await handleRunWorkflow(completeInput)
        handleWorkflowResponse(result)
      } catch (error) {
        logger.error('Error executing workflow from modal submit:', error)
      }

      focusInput(100)
    },
    [
      activeWorkflowId,
      isExecuting,
      startBlockId,
      startBlockInputFormat,
      setSubBlockValue,
      session,
      addToQueue,
      triggerWorkflowUpdate,
      getConversationId,
      handleRunWorkflow,
      handleWorkflowResponse,
      focusInput,
    ]
  )

  const handleRerun = useCallback(() => {
    setIsInputModalOpen(true)
  }, [])

  const handleKeyPress = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (!isStreaming && !isExecuting) {
          handleSendMessage()
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (promptHistory.length > 0) {
          const newIndex =
            historyIndex === -1 ? promptHistory.length - 1 : Math.max(0, historyIndex - 1)
          setHistoryIndex(newIndex)
          setChatMessage(promptHistory[newIndex])
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (historyIndex >= 0) {
          const newIndex = historyIndex + 1
          if (newIndex >= promptHistory.length) {
            setHistoryIndex(-1)
            setChatMessage('')
          } else {
            setHistoryIndex(newIndex)
            setChatMessage(promptHistory[newIndex])
          }
        }
      }
    },
    [handleSendMessage, promptHistory, historyIndex, isStreaming, isExecuting]
  )

  const handleOutputSelection = useCallback(
    (values: string[]) => {
      if (!activeWorkflowId) return

      const dedupedValues = [...new Set(values)]
      setSelectedWorkflowOutput(activeWorkflowId, dedupedValues)
    },
    [activeWorkflowId, setSelectedWorkflowOutput]
  )

  const handleClose = useCallback(() => {
    setIsChatOpen(false)
  }, [setIsChatOpen])

  const handleConfigureStartInputs = useCallback(() => {
    if (!activeWorkflowId || !startBlockId) {
      logger.warn('Cannot configure start inputs: missing active workflow ID or start block ID')
      return
    }

    try {
      const normalizedExisting = normalizeInputFormatValue(startBlockInputFormat)

      const newReservedFields: StartInputFormatField[] = missingStartReservedFields.map(
        (fieldName) => {
          const defaultType = fieldName === 'files' ? 'file[]' : 'string'

          return {
            id: generateId(),
            name: fieldName,
            type: defaultType,
            value: '',
            collapsed: false,
          }
        }
      )

      const updatedFields: StartInputFormatField[] = [...newReservedFields, ...normalizedExisting]

      setSubBlockValue(startBlockId, 'inputFormat', updatedFields)

      const userId = session?.user?.id || 'unknown'
      addToQueue({
        id: generateId(),
        operation: {
          operation: 'subblock-update',
          target: 'subblock',
          payload: {
            blockId: startBlockId,
            subblockId: 'inputFormat',
            value: updatedFields,
          },
        },
        workflowId: activeWorkflowId,
        userId,
      })

      triggerWorkflowUpdate()
    } catch (error) {
      logger.error('Failed to configure start block reserved inputs', error)
    }
  }, [
    activeWorkflowId,
    missingStartReservedFields,
    setSubBlockValue,
    startBlockId,
    startBlockInputFormat,
    triggerWorkflowUpdate,
    session,
    addToQueue,
  ])

  if (!isChatOpen) return null

  return (
    <div
      ref={preventZoomRef}
      role='dialog'
      aria-label='Chat'
      className='fixed z-30 flex flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 pt-0.5 pb-2 motion-reduce:transition-none max-md:absolute max-md:inset-0! max-md:size-auto! max-md:cursor-default! max-md:rounded-none max-md:border-0 max-md:pb-[max(8px,env(safe-area-inset-bottom))]'
      style={{
        left: `${actualPosition.x}px`,
        top: `${actualPosition.y}px`,
        width: `${chatWidth}px`,
        height: `${chatHeight}px`,
        cursor: resizeCursor || undefined,
      }}
      onMouseMove={(event) => {
        if (isFloatingLayout()) handleResizeMouseMove(event)
      }}
      onMouseLeave={handleResizeMouseLeave}
      onMouseDown={(event) => {
        if (isFloatingLayout()) handleResizeMouseDown(event)
      }}
    >
      <div
        role='presentation'
        className='flex h-[32px] shrink-0 cursor-grab items-center justify-between gap-2.5 bg-[var(--surface-1)] p-0 active:cursor-grabbing max-md:h-auto max-md:min-h-11 max-md:cursor-default max-md:flex-wrap'
        onMouseDown={(event) => {
          if (isFloatingLayout()) handleMouseDown(event)
        }}
      >
        <span className='shrink-0 pr-0.5 text-[var(--text-primary)] text-sm'>Chat</span>

        <div
          className='ml-auto flex min-w-0 shrink items-center gap-1.5 max-md:order-3 max-md:w-full max-md:justify-end max-md:pb-2'
          onMouseDown={(e) => e.stopPropagation()}
        >
          {customFields.length > 0 && (
            <Badge
              variant='outline'
              className='flex-none cursor-pointer whitespace-nowrap rounded-[6px]'
              title='Re-run with new inputs'
              onMouseDown={(e: MouseEvent) => {
                e.stopPropagation()
                handleRerun()
              }}
            >
              <span className='whitespace-nowrap text-[12px]'>Re-run</span>
            </Badge>
          )}

          {shouldShowConfigureStartInputsButton && (
            <button
              type='button'
              className='flex flex-none cursor-pointer items-center whitespace-nowrap rounded-md border border-[var(--border-1)] bg-[var(--surface-5)] px-2.5 py-0.5 font-sans text-[var(--text-primary)] text-caption hover-hover:bg-[var(--surface-active)] max-md:pointer-coarse:min-h-11'
              title='Add chat inputs to Start block'
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                handleConfigureStartInputs()
                workflowChatAddInputEvent({
                  'Workspace Name': workspaceName,
                  'Workspace ID': workspaceId,
                })
              }}
            >
              <span className='whitespace-nowrap'>Add inputs</span>
            </button>
          )}

          <OutputSelect
            workflowId={activeWorkflowId}
            selectedOutputs={selectedOutputs}
            onOutputSelect={handleOutputSelection}
            disabled={!activeWorkflowId}
            placeholder='Outputs'
            align='end'
            maxHeight={180}
            workspaceName={workspaceName}
            workspaceId={workspaceId}
            className='max-md:pointer-coarse:min-h-11'
          />
        </div>

        <div className='flex shrink-0 items-center gap-2'>
          {/* More menu with actions */}
          <Popover size='sm' open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                aria-label='Chat actions'
                variant='ghost'
                iconPadding='md'
                className='-m-1.5 max-md:m-0 max-md:size-11'
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className='size-[14px]' />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side='bottom'
              align='end'
              sideOffset={8}
              maxHeight={100}
              style={{ width: '110px', minWidth: '110px' }}
            >
              <PopoverScrollArea>
                <PopoverItem
                  onClick={() => {
                    if (activeWorkflowId) exportChatCSV(activeWorkflowId)
                    setMoreMenuOpen(false)
                  }}
                  disabled={workflowMessages.length === 0}
                >
                  <Download className='size-[13px]' />
                  <span>Export</span>
                </PopoverItem>
                <PopoverItem
                  onClick={() => {
                    if (activeWorkflowId) clearChat(activeWorkflowId)
                    setMoreMenuOpen(false)
                  }}
                  disabled={workflowMessages.length === 0}
                >
                  <Trash className='size-[13px]' />
                  <span>Clear</span>
                </PopoverItem>
              </PopoverScrollArea>
            </PopoverContent>
          </Popover>

          {/* Close button */}
          <Button
            aria-label='Close chat'
            variant='ghost'
            iconPadding='md'
            className='-m-1.5 max-md:m-0 max-md:size-11'
            onClick={handleClose}
          >
            <X className='size-[16px]' />
          </Button>
        </div>
      </div>

      {/* Chat content */}
      <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
        {/* Messages */}
        <div className='flex-1 overflow-hidden'>
          {workflowMessages.length === 0 ? (
            <div className='flex h-full items-center justify-center text-[var(--text-placeholder)] text-small'>
              No messages yet
            </div>
          ) : (
            <div ref={scrollAreaRef} className='h-full overflow-y-auto overflow-x-hidden'>
              <div className='w-full max-w-full space-y-2 overflow-hidden py-2'>
                {workflowMessages.map((message) => (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    onToggleGeneratedImage={toggleGeneratedImageSelection}
                    onToggleUserAttachmentImage={handleToggleUserAttachmentImageSelection}
                    selectedGeneratedImageIds={selectedGeneratedImageIds}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          className='flex-none'
          onDragEnter={!activeWorkflowId || isExecuting ? undefined : handleDragEnter}
          onDragOver={!activeWorkflowId || isExecuting ? undefined : handleDragOver}
          onDragLeave={!activeWorkflowId || isExecuting ? undefined : handleDragLeave}
          onDrop={!activeWorkflowId || isExecuting ? undefined : handleDrop}
        >
          {uploadErrors.length > 0 && (
            <div>
              <div className='rounded-lg border border-[var(--terminal-status-error-border)] bg-[var(--terminal-status-error-bg)]'>
                <div className='flex items-start gap-2'>
                  <CircleAlert className='mt-0.5 size-3 shrink-0 text-[var(--text-error)]' />
                  <div className='flex-1'>
                    <div className='mb-1 text-[var(--text-error)] text-caption'>
                      File upload error
                    </div>
                    <div className='space-y-1'>
                      {uploadErrors.map((err, idx) => (
                        <div key={idx} className='text-[var(--text-error)] text-micro'>
                          {err}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div
            className={`rounded-sm border bg-[var(--surface-5)] py-0 pr-1.5 pl-1 transition-colors ${
              isDragOver ? 'border-[var(--brand-secondary)]' : 'border-[var(--border-1)]'
            }`}
          >
            {effectiveGeneratedImages.length > 0 && (
              <div className='mt-1 flex flex-wrap gap-1.5'>
                {effectiveGeneratedImages.map((image) => (
                  <div
                    key={image.id}
                    className='group relative h-[40px] w-[40px] flex-shrink-0 overflow-hidden rounded-md bg-[var(--surface-2)]'
                    title={
                      selectedGeneratedImages.length > 0
                        ? `${image.name} (selected from chat)`
                        : `${image.name} (latest image)`
                    }
                  >
                    <img src={image.url} alt={image.name} className='h-full w-full object-cover' />
                    <Button
                      variant='ghost'
                      onClick={(e) => {
                        e.stopPropagation()
                        removeSelectedGeneratedImage(image.id)
                      }}
                      className='absolute top-0.5 right-0.5 h-4 w-4 p-0 opacity-0 transition-opacity group-hover:opacity-100'
                    >
                      <X className='h-2.5 w-2.5' />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {chatFiles.length > 0 && (
              <div
                ref={attachmentsRef}
                className={cn(
                  'mt-1 pointer-coarse:max-h-[102px] pointer-coarse:overflow-y-auto pointer-coarse:overscroll-contain',
                  scrollFadeClass
                )}
                {...scrollFadeAttributes(attachmentEdges)}
              >
                <div className='flex flex-wrap gap-1.5'>
                  {chatFiles.map((file) => (
                    <ChatFilePreview key={file.id} file={file} onRemove={removeFile} />
                  ))}
                </div>
              </div>
            )}

            {/* Input field with inline buttons */}
            <div className='relative max-md:flex max-md:items-center'>
              <Input
                ref={inputRef}
                value={chatMessage}
                onChange={(e) => {
                  setChatMessage(e.target.value)
                  setHistoryIndex(-1)
                }}
                onKeyDown={handleKeyPress}
                placeholder={isDragOver ? 'Drop files here...' : 'Type a message...'}
                className='w-full border-0 bg-transparent pr-[56px] pl-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 max-md:min-w-0 max-md:flex-1 max-md:pr-1'
                disabled={!activeWorkflowId}
              />

              {/* Buttons positioned absolutely on the right */}
              <div className='-translate-y-1/2 absolute top-1/2 right-[2px] flex items-center gap-2.5 max-md:static max-md:translate-y-0 max-md:gap-1'>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <Button
                      aria-label='Attach file'
                      variant='ghost'
                      size={null}
                      disabled={
                        !activeWorkflowId || isExecuting || chatFiles.length >= MAX_CHAT_FILES
                      }
                      onClick={() => document.getElementById('floating-chat-file-input')?.click()}
                      className={cn(
                        'size-[14px] cursor-pointer rounded-md border-0! bg-transparent! p-0 max-md:size-11',
                        (!activeWorkflowId || isExecuting || chatFiles.length >= MAX_CHAT_FILES) &&
                          'cursor-not-allowed opacity-50'
                      )}
                    >
                      <Paperclip className='size-3.5!' />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>Attach file</Tooltip.Content>
                </Tooltip.Root>

                {isStreaming ? (
                  <ComposerActionButton
                    aria-label='Stop generation'
                    onClick={handleStopStreaming}
                    size='sm'
                    className='max-md:size-11'
                  >
                    <Square className='size-2.5 fill-white text-white dark:fill-black dark:text-black' />
                  </ComposerActionButton>
                ) : (
                  <ComposerActionButton
                    aria-label='Send message'
                    onClick={handleSendMessage}
                    size='sm'
                    className='max-md:size-11'
                    disabled={
                      (!chatMessage.trim() &&
                        chatFiles.length === 0 &&
                        effectiveGeneratedImages.length === 0) ||
                      !activeWorkflowId ||
                      isExecuting ||
                      isStreaming
                    }
                    active={
                      !!(
                        chatMessage.trim() ||
                        chatFiles.length > 0 ||
                        effectiveGeneratedImages.length > 0
                      )
                    }
                  >
                    <ArrowUp className='size-3.5 text-white dark:text-black' />
                  </ComposerActionButton>
                )}
              </div>
            </div>

            <input
              id='floating-chat-file-input'
              type='file'
              multiple
              accept={CHAT_ACCEPT_ATTRIBUTE}
              onChange={handleFileInputChange}
              className='hidden'
              disabled={!activeWorkflowId || isExecuting}
            />
          </div>
        </div>
      </div>

      {customFields.length > 0 && (
        <StartBlockInputModal
          open={isInputModalOpen}
          onOpenChange={setIsInputModalOpen}
          inputFormat={startBlockInputFormat as InputFormatField[] | null | undefined}
          onSubmit={handleStartBlockInputsSubmit}
          initialValues={startBlockInputs}
        />
      )}
    </div>
  )
}
