'use client'

import { useRef, useState } from 'react'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import {
  anyToolCallRunning,
  applyToolCallPhase,
  settleRunningToolCalls,
  snapshotToolCalls,
  toolCallKey,
} from '@/components/agent-stream/tool-call-lifecycle'
import {
  extractChartsFromData,
  formatChartDeployOutputForChat,
  formatChartsForChat,
} from '@/lib/chart-generation/echarts-option'
import {
  type AssistantChatFile as ChatFile,
  extractAssistantFilesFromData,
  extractGeneratedImagesFromData,
} from '@/lib/chat/assistant-assets'
import { readSSEEvents } from '@/lib/core/utils/sse'
import {
  isChatChunkFrame,
  isChatChunkResetFrame,
  isChatErrorFrame,
  isChatFinalFrame,
  isChatStreamErrorFrame,
  isChatThinkingFrame,
  isChatToolFrame,
} from '@/lib/workflows/streaming/agent-stream-protocol'
import type { ChatMessage, ChatToolCall } from '@/app/(interfaces)/chat/components/message/message'
import { CHAT_ERROR_MESSAGES } from '@/app/(interfaces)/chat/constants'
import { resolveMessageImagesAndProse } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components/chat-message/constants'

const logger = createLogger('UseChatStreaming')

export interface StreamingOptions {
  outputConfigs?: Array<{ blockId: string; path?: string }>
  /**
   * Shared AbortController for fetch + SSE body reads. When provided (preferred),
   * Stop aborts the in-flight request server-side as well as the reader.
   */
  abortController?: AbortController
}

/** Client-side view of the `final` frame's opaque `data` payload. */
interface ChatFinalData {
  success?: boolean
  error?: string | { message?: string }
  output?: Record<string, Record<string, unknown>>
  executionId?: string
}

type GeneratedImage = ReturnType<typeof extractGeneratedImagesFromData>[number]

type StreamSSEPayload = {
  blockId?: string
  chunk?: string
  event?: string
  error?: string
  data?: ChatFinalData | ChatMessage['knowledgeResults']
}

export function useChatStreaming() {
  const [isStreamingResponse, setIsStreamingResponse] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const accumulatedTextRef = useRef<string>('')
  const accumulatedThinkingRef = useRef<string>('')
  const accumulatedToolCallsRef = useRef<ChatToolCall[]>([])

  const stopStreaming = (setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null

      const latestContent = accumulatedTextRef.current
      const latestThinking = accumulatedThinkingRef.current
      const latestTools = accumulatedToolCallsRef.current.map((tool) =>
        tool.status === 'running' ? { ...tool, status: 'cancelled' as const } : tool
      )

      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1]

        if (lastMessage && lastMessage.type === 'assistant') {
          const content = latestContent || lastMessage.content
          const updatedContent =
            content + (content ? '\n\n_Response stopped by user._' : '_Response stopped by user._')

          return [
            ...prev.slice(0, -1),
            {
              ...lastMessage,
              content: updatedContent,
              // Preserve any thinking / tools received before Stop.
              thinking: latestThinking || lastMessage.thinking,
              toolCalls: latestTools.length > 0 ? latestTools : lastMessage.toolCalls,
              isStreaming: false,
              isThinkingStreaming: false,
              isToolStreaming: false,
            },
          ]
        }

        return prev
      })

      setIsStreamingResponse(false)
      accumulatedTextRef.current = ''
      accumulatedThinkingRef.current = ''
      accumulatedToolCallsRef.current = []
    }
  }

  const handleStreamedResponse = async (
    response: Response,
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
    setIsLoading: React.Dispatch<React.SetStateAction<boolean>>,
    scrollToBottom: () => void,
    streamingOptions?: StreamingOptions
  ) => {
    logger.info('[useChatStreaming] handleStreamedResponse called')
    setIsStreamingResponse(true)

    if (streamingOptions?.abortController) {
      abortControllerRef.current = streamingOptions.abortController
    } else if (!abortControllerRef.current) {
      abortControllerRef.current = new AbortController()
    }

    if (!response.body) {
      setIsLoading(false)
      setIsStreamingResponse(false)
      return
    }

    /**
     * Answer text tracked per block so a `chunk_reset` (dual-gated streams:
     * a live-streamed turn resolved to tool calls) can clear one block's
     * contribution. `accumulatedText` is re-derived on every mutation —
     * cross-block separators arrive baked into the chunks.
     */
    const blockTextOrder: string[] = []
    const blockTextSegments = new Map<string, string>()
    let accumulatedText = ''
    const recomputeAccumulatedText = () => {
      accumulatedText = blockTextOrder.map((id) => blockTextSegments.get(id) ?? '').join('')
      accumulatedTextRef.current = accumulatedText
    }
    let accumulatedThinking = ''
    let isThinkingStreaming = false
    let pendingKnowledgeResults: ChatMessage['knowledgeResults']
    const toolCallsMap = new Map<string, ChatToolCall>()
    const toolCallOrder: string[] = []

    const syncToolCallsRef = () => {
      accumulatedToolCallsRef.current = snapshotToolCalls(toolCallOrder, toolCallsMap) ?? []
    }

    const messageId = generateId()

    const UI_BATCH_MAX_MS = 50
    let uiDirty = false
    let uiRAF: number | null = null
    let uiTimer: ReturnType<typeof setTimeout> | null = null
    let lastUIFlush = 0

    const flushUI = () => {
      if (uiRAF !== null) {
        cancelAnimationFrame(uiRAF)
        uiRAF = null
      }
      if (uiTimer !== null) {
        clearTimeout(uiTimer)
        uiTimer = null
      }
      if (!uiDirty) return
      uiDirty = false
      lastUIFlush = performance.now()
      const contentSnapshot = accumulatedText
      const thinkingSnapshot = accumulatedThinking
      const thinkingStreamingSnapshot = isThinkingStreaming
      const toolCallsSnapshot = snapshotToolCalls(toolCallOrder, toolCallsMap)
      const toolStreamingSnapshot = anyToolCallRunning(toolCallsMap)
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== messageId) return msg
          if (!msg.isStreaming) return msg
          return {
            ...msg,
            content: contentSnapshot,
            thinking: thinkingSnapshot || undefined,
            isThinkingStreaming: thinkingStreamingSnapshot,
            toolCalls: toolCallsSnapshot,
            isToolStreaming: toolStreamingSnapshot,
          }
        })
      )
      // Caller supplies a stick-to-bottom-aware scroller (no-ops if user scrolled away).
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    }

    const scheduleUIFlush = () => {
      if (uiRAF !== null) return
      const elapsed = performance.now() - lastUIFlush
      if (elapsed >= UI_BATCH_MAX_MS) {
        flushUI()
        return
      }
      uiRAF = requestAnimationFrame(flushUI)
      if (uiTimer === null) {
        uiTimer = setTimeout(flushUI, Math.max(0, UI_BATCH_MAX_MS - elapsed))
      }
    }
    setMessages((prev) => [
      ...prev,
      {
        id: messageId,
        content: '',
        type: 'assistant',
        timestamp: new Date(),
        isStreaming: true,
        liked: null,
      },
    ])

    setIsLoading(false)

    let terminated = false
    // Capture before Stop nulls abortControllerRef; needed when the reader
    // resolves on abort instead of throwing AbortError.
    const streamAbortSignal = abortControllerRef.current!.signal

    try {
      await readSSEEvents<Record<string, unknown>>(response.body, {
        signal: streamAbortSignal,
        onParseError: (_data, parseError) => {
          logger.error('Error parsing stream data:', parseError)
        },
        onEvent: async (json) => {
          const forkKnowledgeResults = readForkKnowledgeResultsEvent(json as StreamSSEPayload)
          if (forkKnowledgeResults !== undefined) {
            pendingKnowledgeResults = forkKnowledgeResults
            return false
          }

          if (isChatErrorFrame(json)) {
            // User Stop aborts the fetch; the server often still emits a terminal
            // `{ event: 'error', error: 'Client cancelled request' }` before the
            // SSE reader finishes. Do not overwrite the stop notice.
            if (streamAbortSignal.aborted) {
              settleRunningToolCalls(toolCallsMap, 'cancelled')
              syncToolCallsRef()
              const toolsSnapshot = snapshotToolCalls(toolCallOrder, toolCallsMap)
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === messageId
                    ? {
                        ...msg,
                        isStreaming: false,
                        isThinkingStreaming: false,
                        isToolStreaming: false,
                        thinking: accumulatedThinking || msg.thinking,
                        toolCalls: toolsSnapshot ?? msg.toolCalls,
                      }
                    : msg
                )
              )
              setIsLoading(false)
              terminated = true
              return true
            }

            const errorMessage = json.error || CHAT_ERROR_MESSAGES.GENERIC_ERROR
            settleRunningToolCalls(toolCallsMap, 'error')
            syncToolCallsRef()
            const toolsSnapshot = snapshotToolCalls(toolCallOrder, toolCallsMap)
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId
                  ? {
                      ...msg,
                      content: errorMessage,
                      thinking: accumulatedThinking || msg.thinking,
                      toolCalls: toolsSnapshot ?? msg.toolCalls,
                      isStreaming: false,
                      isThinkingStreaming: false,
                      isToolStreaming: false,
                      type: 'assistant' as const,
                    }
                  : msg
              )
            )
            setIsLoading(false)
            terminated = true
            return true
          }

          if (isChatStreamErrorFrame(json)) {
            // Non-terminal mid-block read issue: keep streaming. The legacy
            // client ignored these frames; log only — never repurpose the
            // thinking lane for error text.
            logger.warn('[useChatStreaming] Non-terminal stream_error', {
              blockId: json.blockId,
              error: json.error || 'A streaming error occurred',
            })
            return false
          }

          if (isChatThinkingFrame(json)) {
            accumulatedThinking += json.data
            accumulatedThinkingRef.current = accumulatedThinking
            isThinkingStreaming = true
            uiDirty = true
            scheduleUIFlush()
            return false
          }

          if (isChatToolFrame(json)) {
            const { blockId } = json
            // Tools starting means the turn's thinking phase is over — settle
            // the thinking chrome (it re-opens if more thinking streams later).
            if (json.phase === 'start' && isThinkingStreaming) {
              isThinkingStreaming = false
            }
            applyToolCallPhase(
              toolCallsMap,
              toolCallOrder,
              {
                key: toolCallKey(blockId, json.id),
                id: json.id,
                name: json.name,
                phase: json.phase,
                status: json.status,
              },
              (tool): ChatToolCall => ({
                ...tool,
                blockId,
                displayName: tool.displayName ?? tool.name,
              })
            )
            syncToolCallsRef()
            uiDirty = true
            scheduleUIFlush()
            return false
          }

          if (isChatFinalFrame(json)) {
            flushUI()
            const finalData = json.data as ChatFinalData
            isThinkingStreaming = false
            // A failed run can still terminate with `final` (success: false) —
            // straggler running chips must not settle green in that case.
            settleRunningToolCalls(toolCallsMap, finalData.success === false ? 'error' : 'success')
            syncToolCallsRef()
            const toolsSnapshot = snapshotToolCalls(toolCallOrder, toolCallsMap)

            const forkFinal = resolveForkFinalStreamState({
              accumulatedText,
              finalData,
              outputConfigs: streamingOptions?.outputConfigs,
              pendingKnowledgeResults,
            })

            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId
                  ? {
                      ...msg,
                      isStreaming: false,
                      isThinkingStreaming: false,
                      isToolStreaming: false,
                      content: forkFinal.content,
                      thinking: accumulatedThinking || msg.thinking,
                      toolCalls: toolsSnapshot ?? msg.toolCalls,
                      executionId: forkFinal.executionId ?? msg.executionId,
                      files: forkFinal.files,
                      generatedImages: forkFinal.generatedImages,
                      knowledgeResults: forkFinal.knowledgeResults,
                    }
                  : msg
              )
            )

            pendingKnowledgeResults = undefined
            accumulatedTextRef.current = ''
            accumulatedThinkingRef.current = ''
            accumulatedToolCallsRef.current = []

            terminated = true
            return true
          }

          if (isChatChunkResetFrame(json)) {
            // The block's live-streamed text belonged to an intermediate turn
            // (tool calls follow); drop it — the final turn re-streams after.
            // Remove the block from the order too: its re-streamed text
            // re-registers at the end, keeping render order = arrival order
            // (the server re-computes the cross-block separator on re-stream).
            const { blockId } = json
            if (blockTextSegments.has(blockId)) {
              blockTextSegments.delete(blockId)
              const orderIndex = blockTextOrder.indexOf(blockId)
              if (orderIndex !== -1) {
                blockTextOrder.splice(orderIndex, 1)
              }
              recomputeAccumulatedText()
              uiDirty = true
              scheduleUIFlush()
            }
            return false
          }

          // Answer text only — never append thinking/tool/unknown chunk frames blindly.
          if (isChatChunkFrame(json)) {
            const { blockId, chunk: contentChunk } = json

            // First answer chunk settles thinking chrome (still visible, no longer “live”).
            if (isThinkingStreaming) {
              isThinkingStreaming = false
            }

            if (!blockTextSegments.has(blockId)) {
              blockTextOrder.push(blockId)
              blockTextSegments.set(blockId, '')
            }
            blockTextSegments.set(blockId, blockTextSegments.get(blockId)! + contentChunk)
            recomputeAccumulatedText()
            logger.debug('[useChatStreaming] Received chunk', {
              blockId,
              chunkLength: contentChunk.length,
              totalLength: accumulatedText.length,
              messageId,
              chunk: contentChunk.substring(0, 20),
            })
            uiDirty = true
            scheduleUIFlush()
          }
        },
      })

      if (!terminated) {
        flushUI()
        // Stream closed without a terminal final/error frame (abrupt disconnect,
        // or only non-terminal stream_error). Clear live chrome so the UI does not
        // stay stuck in a streaming/loading state.
        const wasAborted = streamAbortSignal.aborted
        settleRunningToolCalls(toolCallsMap, wasAborted ? 'cancelled' : 'error')
        syncToolCallsRef()
        isThinkingStreaming = false
        const toolsSnapshot = snapshotToolCalls(toolCallOrder, toolCallsMap)
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== messageId) return msg
            // stopStreaming already wrote the stop notice into content; do not clobber it.
            if (wasAborted) {
              return {
                ...msg,
                isStreaming: false,
                isThinkingStreaming: false,
                isToolStreaming: false,
                thinking: accumulatedThinking || msg.thinking,
                toolCalls: toolsSnapshot ?? msg.toolCalls,
              }
            }
            return {
              ...msg,
              isStreaming: false,
              isThinkingStreaming: false,
              isToolStreaming: false,
              content: accumulatedText || msg.content,
              thinking: accumulatedThinking || msg.thinking,
              toolCalls: toolsSnapshot ?? msg.toolCalls,
            }
          })
        )
      }
    } catch (error) {
      // Stop / timeout abort the shared fetch controller; body read then throws AbortError.
      // Expected cancel, not a hard failure.
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('Stream aborted by user or timeout')
        settleRunningToolCalls(toolCallsMap, 'cancelled')
      } else {
        logger.error('Error processing stream:', error)
        settleRunningToolCalls(toolCallsMap, 'error')
      }
      syncToolCallsRef()
      flushUI()
      const toolsSnapshot = snapshotToolCalls(toolCallOrder, toolCallsMap)
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                isStreaming: false,
                isThinkingStreaming: false,
                isToolStreaming: false,
                thinking: accumulatedThinking || msg.thinking,
                toolCalls: toolsSnapshot ?? msg.toolCalls,
              }
            : msg
        )
      )
    } finally {
      if (uiRAF !== null) cancelAnimationFrame(uiRAF)
      if (uiTimer !== null) clearTimeout(uiTimer)
      setIsStreamingResponse(false)
      abortControllerRef.current = null

      // Stick-to-bottom-aware; no-ops if the user scrolled away mid-stream.
      setTimeout(() => {
        scrollToBottom()
      }, 300)
    }
  }

  return {
    isStreamingResponse,
    abortControllerRef,
    stopStreaming,
    handleStreamedResponse,
  }
}

interface ForkFinalStreamInput {
  accumulatedText: string
  finalData: ChatFinalData
  outputConfigs?: StreamingOptions['outputConfigs']
  pendingKnowledgeResults?: ChatMessage['knowledgeResults']
}

interface ForkFinalStreamState {
  content: string | Record<string, unknown>
  executionId?: string
  files?: ChatFile[]
  generatedImages?: GeneratedImage[]
  knowledgeResults?: ChatMessage['knowledgeResults']
}

/**
 * Reads a fork-specific `knowledgeResults` SSE event without touching the main event dispatch flow.
 */
function readForkKnowledgeResultsEvent(
  json: StreamSSEPayload
): ChatMessage['knowledgeResults'] | undefined {
  if (json.event !== 'knowledgeResults' || !Array.isArray(json.data)) {
    return undefined
  }

  return json.data as ChatMessage['knowledgeResults']
}

/**
 * Resolves the assistant message produced by a `final` SSE event, including fork extensions
 * for knowledge results, generated images, and assistant file attachments.
 */
function resolveForkFinalStreamState(input: ForkFinalStreamInput): ForkFinalStreamState {
  const { accumulatedText, finalData, outputConfigs, pendingKnowledgeResults } = input
  const collected = collectForkConfiguredOutputs(outputConfigs, finalData.output)

  let finalContent = accumulatedText

  if (collected.formattedOutputs.length > 0) {
    const nonEmptyOutputs = collected.formattedOutputs.filter((output) => output.trim())
    if (nonEmptyOutputs.length > 0) {
      const combinedOutputs = nonEmptyOutputs.join('\n\n')
      finalContent = finalContent ? `${finalContent.trim()}\n\n${combinedOutputs}` : combinedOutputs
    }
  }

  if (!finalContent && collected.extractedFiles.length === 0) {
    const fallbackContent = resolveForkFallbackContent(finalData)
    if (fallbackContent) {
      finalContent = fallbackContent
    }
  }

  const { content, generatedImages } = resolveForkContentWithImages(
    finalContent,
    collected.generatedImages
  )

  return {
    content,
    executionId: finalData.executionId,
    files: collected.extractedFiles.length > 0 ? collected.extractedFiles : undefined,
    generatedImages,
    knowledgeResults: pendingKnowledgeResults,
  }
}

function collectForkConfiguredOutputs(
  outputConfigs: StreamingOptions['outputConfigs'],
  blockOutputMap?: Record<string, Record<string, unknown>>
) {
  const formattedOutputs: string[] = []
  const extractedFiles: ChatFile[] = []
  let generatedImages: GeneratedImage[] = []

  if (!outputConfigs?.length || !blockOutputMap) {
    return { formattedOutputs, extractedFiles, generatedImages }
  }

  for (const config of outputConfigs) {
    const blockOutputs = blockOutputMap[config.blockId]
    if (!blockOutputs) continue

    const value = getForkBlockOutputValue(blockOutputs, config.path)

    if (config.path === 'results' && isForkKnowledgeResultsArray(value)) {
      continue
    }

    const images = extractGeneratedImagesFromData(value)
    if (images.length > 0) {
      generatedImages = extractGeneratedImagesFromData(value, generatedImages)
      continue
    }

    const files = extractAssistantFilesFromData(value)
    if (files.length > 0) {
      extractedFiles.push(...files)
      generatedImages = extractGeneratedImagesFromData(value, generatedImages)
      continue
    }

    const formatted = formatForkStreamOutputValue(value)
    if (formatted) {
      formattedOutputs.push(formatted)
    }

    // Surface charts nested inside the full block output (e.g. the Agent block
    // calling Chart Generator as a tool, where the chart lands in
    // `toolCalls.list[].result`). Only append charts not already rendered by the
    // selected value, so the standalone Chart Generator block never duplicates.
    const chartFromNested = resolveNestedChartOutput(blockOutputs, value)
    if (chartFromNested) {
      formattedOutputs.push(chartFromNested)
    }
  }

  return { formattedOutputs, extractedFiles, generatedImages }
}

/**
 * Returns chart content found deeper in the block output than the selected value
 * (Agent tool-call results), de-duplicated against charts already present in the
 * selected value. Returns null when there is nothing new to render.
 */
function resolveNestedChartOutput(
  blockOutputs: Record<string, unknown>,
  selectedValue: unknown
): string | null {
  const allCharts = extractChartsFromData(blockOutputs)
  if (allCharts.length === 0) {
    return null
  }

  const existingSignatures = new Set(
    extractChartsFromData(selectedValue).map((option) => JSON.stringify(option))
  )
  const newCharts = allCharts.filter((option) => !existingSignatures.has(JSON.stringify(option)))

  return formatChartsForChat(newCharts)
}

interface StreamFinalData {
  success?: boolean
  output?: Record<string, { results?: unknown } | undefined>
  error?: string | { message?: string }
}

function resolveForkFallbackContent(finalData: StreamFinalData): string | undefined {
  if (finalData.error) {
    if (typeof finalData.error === 'string') {
      return finalData.error
    }

    if (typeof finalData.error.message === 'string') {
      return finalData.error.message
    }
  }

  if (!finalData.success || !finalData.output) {
    return undefined
  }

  return (
    Object.values(finalData.output)
      .filter((block) => !isForkKnowledgeResultsArray(block?.results))
      .map((block) => formatForkStreamOutputValue(block)?.trim())
      .filter(Boolean)[0] ?? undefined
  )
}

function resolveForkContentWithImages(
  finalContent: string,
  generatedImages: GeneratedImage[]
): { content: string | Record<string, unknown>; generatedImages?: GeneratedImage[] } {
  let content: string | Record<string, unknown> = finalContent

  if (generatedImages.length > 0) {
    const { prose } = resolveMessageImagesAndProse(finalContent)
    const imageUrls = generatedImages.map((image) => image.url)
    content = {
      content: prose,
      image: imageUrls[0] ?? '',
      images: imageUrls,
    }
  }

  const resolvedGeneratedImages =
    generatedImages.length > 0 ? generatedImages : extractGeneratedImagesFromData(content)

  return {
    content,
    generatedImages: resolvedGeneratedImages.length > 0 ? resolvedGeneratedImages : undefined,
  }
}

function isForkKnowledgeResultsArray(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        'documentId' in item &&
        'documentName' in item &&
        'content' in item &&
        'chunkIndex' in item
    )
  )
}

function getForkBlockOutputValue(blockOutputs: Record<string, unknown>, path?: string) {
  if (!path || path === 'content') {
    if (blockOutputs.content !== undefined) return blockOutputs.content
    if (blockOutputs.result !== undefined) return blockOutputs.result
    return blockOutputs
  }

  if (blockOutputs[path] !== undefined) {
    return blockOutputs[path]
  }

  if (path.includes('.')) {
    return path.split('.').reduce<unknown>((current, segment) => {
      if (current && typeof current === 'object' && segment in current) {
        return (current as Record<string, unknown>)[segment]
      }

      return undefined
    }, blockOutputs)
  }

  return undefined
}

function formatForkStreamOutputValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (extractAssistantFilesFromData(value).length > 0) {
    return null
  }

  if (extractGeneratedImagesFromData(value).length > 0) {
    return null
  }

  if (Array.isArray(value) && value.length === 0) {
    return null
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'object') {
    const chartOutput = formatChartDeployOutputForChat(value)
    if (chartOutput) {
      return chartOutput
    }
    if (
      value &&
      typeof value === 'object' &&
      'charts' in value &&
      Array.isArray((value as { charts?: unknown }).charts)
    ) {
      return null
    }
    try {
      return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
    } catch {
      return String(value)
    }
  }

  return String(value)
}
