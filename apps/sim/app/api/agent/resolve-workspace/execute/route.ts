import { db } from '@sim/db'
import { copilotChats } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { generateRequestId } from '@/lib/core/utils/request'
import { fetchStreamingPost } from '@/lib/core/utils/streaming-fetch'
import { appendCopilotChatMessages } from '@/lib/mothership/chat/messages-store'
import { normalizeMessage, type PersistedMessage } from '@/lib/mothership/chat/persisted-message'
import { chatPubSub } from '@/lib/mothership/chat-status'
import { requestChatTitle } from '@/lib/mothership/request/lifecycle/start'

const logger = createLogger('AgentResolveWorkspaceExecute')

const ExecuteRequestSchema = z.object({
  userApiKey: z.string().optional(),
  workflowId: z.string().uuid().optional(),
  input: z.string().min(1),
  conversationId: z.string().optional(),
  selectedOutputs: z.array(z.string()).default([]),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type TextEnvelope = {
  v: 1
  type: 'text'
  seq: number
  ts: string
  stream: {
    streamId: string
    chatId: string
    cursor: string
  }
  trace: {
    requestId: string
  }
  scope?: {
    lane: 'subagent'
    agentId?: string
    parentToolCallId?: string
  }
  payload: {
    channel: 'assistant'
    text: string
  }
}

type CompleteEnvelope = {
  v: 1
  type: 'complete'
  seq: number
  ts: string
  stream: {
    streamId: string
    chatId: string
    cursor: string
  }
  trace: {
    requestId: string
  }
  scope?: {
    lane: 'subagent'
    agentId?: string
    parentToolCallId?: string
  }
  payload: {
    status: 'complete'
  }
}

type ToolEnvelope = {
  v: 1
  type: 'tool'
  seq: number
  ts: string
  stream: {
    streamId: string
    chatId: string
    cursor: string
  }
  trace: {
    requestId: string
  }
  scope?: {
    lane: 'subagent'
    agentId?: string
    parentToolCallId?: string
  }
  payload: {
    toolCallId: string
    toolName: 'run'
    arguments?: {
      request: string
    }
    argumentsDelta?: string
    executor?: 'sim'
    mode?: 'async'
    phase: 'args_delta' | 'call' | 'result'
    status?: 'executing' | 'success' | 'error' | 'cancelled'
    ui?: {
      title: string
      phaseLabel: string
      icon: 'play'
      internal: true
    }
    success?: boolean
    output?: unknown
    error?: string
  }
}

const STATUS_ROTATION_MS = 2_500

type StatusCategory = 'email' | 'drive' | 'calendar' | 'arena'

const STATUS_CATEGORY_PATTERNS: Record<StatusCategory, readonly string[]> = {
  email: ['email', 'gmail', 'inbox'],
  drive: ['drive', 'document', 'file'],
  calendar: ['calendar', 'meeting', 'event'],
  arena: ['arena', 'task', 'project', 'workflow'],
}

const STATUS_CATEGORY_MESSAGES: Record<StatusCategory, string> = {
  email: 'Reading emails and preparing the summary...',
  drive: 'Getting details from Drive and related files...',
  calendar: 'Checking calendar events and availability...',
  arena: 'Looking up Arena task and workflow details...',
}

function detectStatusCategories(input: string): StatusCategory[] {
  const normalized = input.toLowerCase()
  return (Object.keys(STATUS_CATEGORY_PATTERNS) as StatusCategory[]).filter((category) =>
    STATUS_CATEGORY_PATTERNS[category].some((pattern) => normalized.includes(pattern))
  )
}

function getDynamicStatusMessages(input: string): string[] {
  const categories = detectStatusCategories(input)
  const messages = ['Reading credentials...', 'Verifying connected service access...']

  if (categories.length > 1) {
    messages.push('Gathering data from multiple sources...')
  }

  for (const category of categories) {
    messages.push(STATUS_CATEGORY_MESSAGES[category])
  }

  if (categories.length === 0) {
    messages.push('Running the workflow and collecting details...')
  } else {
    messages.push('Preparing your response...')
  }

  return messages
}

function extractFirstString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!normalized || normalized === '[DONE]') {
      return undefined
    }
    return value
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>
  const directKeys = [
    'text',
    'chunk',
    'delta',
    'content',
    'message',
    'response',
    'output',
    'answer',
  ] as const

  for (const key of directKeys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate
    }
  }

  const nestedKeys = ['payload', 'data', 'result'] as const
  for (const key of nestedKeys) {
    const nested = extractFirstString(record[key])
    if (nested) return nested
  }

  return undefined
}

function extractTopLevelContent(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const content = (value as Record<string, unknown>).content
  return typeof content === 'string' && content.trim().length > 0 ? content : ''
}

function appendBlockTextParts(blockOutputs: unknown, parts: string[]) {
  if (!blockOutputs || typeof blockOutputs !== 'object') return
  const block = blockOutputs as Record<string, unknown>
  for (const key of ['content', 'result', 'text', 'message', 'response', 'answer'] as const) {
    const value = block[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      parts.push(value)
      return
    }
  }
}

/** Fallback when selectedOutputs are absent or do not match anything in the payload. */
function extractContentFromFinalData(dataRecord: Record<string, unknown>): string {
  const directContent = extractTopLevelContent(dataRecord)
  if (directContent) return directContent

  const outputContent = extractTopLevelContent(dataRecord.output)
  if (outputContent) return outputContent

  if (!dataRecord.output || typeof dataRecord.output !== 'object') {
    return ''
  }

  const parts: string[] = []
  for (const blockOutputs of Object.values(dataRecord.output as Record<string, unknown>)) {
    appendBlockTextParts(blockOutputs, parts)
  }
  return parts.join('\n\n')
}

function extractTextFromFinalOutput(output: unknown, selectedOutputs: readonly string[]): string {
  if (!output || typeof output !== 'object') return ''

  const outputRecord = output as Record<string, unknown>
  const parts: string[] = []

  if (selectedOutputs.length > 0) {
    for (const outputId of selectedOutputs) {
      const [blockId, ...pathParts] = outputId.split('.')
      if (!blockId) continue
      const blockOutputs = outputRecord[blockId]
      if (!blockOutputs || typeof blockOutputs !== 'object') continue
      if (pathParts.length === 0) {
        appendBlockTextParts(blockOutputs, parts)
        continue
      }
      let current: unknown = blockOutputs
      for (const segment of pathParts) {
        if (!current || typeof current !== 'object' || !(segment in current)) {
          current = undefined
          break
        }
        current = (current as Record<string, unknown>)[segment]
      }
      if (typeof current === 'string' && current.trim().length > 0) {
        parts.push(current)
      }
    }
    if (parts.length > 0) {
      return parts.join('\n\n')
    }
  }

  return extractContentFromFinalData({ output: outputRecord })
}

function extractTextFromWorkflowSsePayload(
  record: Record<string, unknown>,
  selectedOutputs: readonly string[]
): string | undefined {
  const eventType = record.event
  if (typeof eventType !== 'string') {
    return undefined
  }

  switch (eventType) {
    case 'final': {
      const data = record.data
      if (!data || typeof data !== 'object') {
        return ''
      }
      const dataRecord = data as Record<string, unknown>
      if (typeof dataRecord.error === 'string' && dataRecord.error.trim().length > 0) {
        return dataRecord.error
      }
      if (
        dataRecord.error &&
        typeof dataRecord.error === 'object' &&
        typeof (dataRecord.error as { message?: unknown }).message === 'string'
      ) {
        return (dataRecord.error as { message: string }).message
      }
      const fromSelectedOutputs = extractTextFromFinalOutput(dataRecord.output, selectedOutputs)
      if (fromSelectedOutputs) {
        return fromSelectedOutputs
      }
      return extractContentFromFinalData(dataRecord)
    }
    case 'error': {
      if (typeof record.error === 'string' && record.error.trim().length > 0) {
        return record.error
      }
      const data = record.data
      if (data && typeof data === 'object') {
        const dataRecord = data as Record<string, unknown>
        if (typeof dataRecord.error === 'string' && dataRecord.error.trim().length > 0) {
          return dataRecord.error
        }
        if (
          dataRecord.error &&
          typeof dataRecord.error === 'object' &&
          typeof (dataRecord.error as { message?: unknown }).message === 'string'
        ) {
          return (dataRecord.error as { message: string }).message
        }
      }
      return ''
    }
    case 'cancelled':
      return ''
    default:
      return undefined
  }
}

function extractTextFromUpstreamData(raw: string, selectedOutputs: readonly string[]): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '[DONE]') return ''

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object') {
      const controlEventText = extractTextFromWorkflowSsePayload(
        parsed as Record<string, unknown>,
        selectedOutputs
      )
      if (controlEventText !== undefined) {
        return controlEventText
      }
    }
    return extractFirstString(parsed) ?? ''
  } catch {
    return trimmed
  }
}

function toSseDataLine(event: TextEnvelope | CompleteEnvelope | ToolEnvelope): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

async function persistWorkflowChatTurn(params: {
  chatId: string
  userId: string
  userInput: string
  assistantOutput: string
  requestId: string
}) {
  const { chatId, userId, userInput, assistantOutput, requestId } = params
  if (!assistantOutput.trim()) return

  try {
    const [chat] = await db
      .select({
        id: copilotChats.id,
        title: copilotChats.title,
        workspaceId: copilotChats.workspaceId,
      })
      .from(copilotChats)
      .where(
        and(
          eq(copilotChats.id, chatId),
          eq(copilotChats.userId, userId),
          eq(copilotChats.type, 'mothership')
        )
      )
      .limit(1)

    if (chat && !chat.title) {
      const generatedTitle = await requestChatTitle({
        message: userInput,
        model: 'claude-opus-4-6',
      })
      if (generatedTitle) {
        await db
          .update(copilotChats)
          .set({ title: generatedTitle })
          .where(eq(copilotChats.id, chatId))
        if (chat.workspaceId) {
          chatPubSub?.publishStatusChanged({
            workspaceId: chat.workspaceId,
            chatId,
            type: 'renamed',
          })
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to generate title before persisting workflow chat turn', {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const userMessage: PersistedMessage = normalizeMessage({
    id: generateRequestId(),
    role: 'user',
    content: userInput,
    timestamp: new Date().toISOString(),
  })
  const assistantMessage: PersistedMessage = normalizeMessage({
    id: generateRequestId(),
    role: 'assistant',
    content: assistantOutput,
    timestamp: new Date().toISOString(),
    requestId,
    contentBlocks: [
      {
        type: 'text',
        channel: 'assistant',
        content: assistantOutput,
      },
      {
        type: 'complete',
        status: 'complete',
      },
    ],
  })

  // Transcripts live in `copilot_messages` (not the legacy `copilot_chats.messages`
  // JSONB blob). The mothership chat GET reads via `loadCopilotChatMessages`, so
  // writing only to the JSONB column leaves the UI empty after stream refetch.
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(copilotChats)
      .set({
        conversationId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(copilotChats.id, chatId),
          eq(copilotChats.userId, userId),
          eq(copilotChats.type, 'mothership')
        )
      )
      .returning({ model: copilotChats.model })

    if (!updated) return

    await appendCopilotChatMessages(
      chatId,
      [userMessage, assistantMessage],
      { chatModel: updated.model ?? null },
      tx
    )
  })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session?.user?.id) {
    logger.warn('Unauthorized workflow execution request — no active session')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id

  let body: z.infer<typeof ExecuteRequestSchema>
  try {
    body = ExecuteRequestSchema.parse(await req.json())
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid resolve-workspace execute request body', { errors: error.issues })
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const apiKey = body.userApiKey ?? process.env.SIM_WORKFLOW_API_KEY_UNIFIED
  if (!apiKey) {
    logger.error('SIM_WORKFLOW_API_KEY_UNIFIED is not configured — cannot execute workflow')
    return NextResponse.json({ error: 'Agent API not configured' }, { status: 500 })
  }
  const agentBaseUrl = process.env.SIM_AGENT_BASE_URL
  if (!agentBaseUrl) {
    logger.error('SIM_AGENT_BASE_URL is not configured — cannot execute workflow')
    return NextResponse.json({ error: 'Agent base URL not configured' }, { status: 500 })
  }
  const executeUrl = `${agentBaseUrl.replace(/\/$/, '')}/api/workflows/${body.workflowId}/execute`

  try {
    const streamId = generateRequestId()
    const requestId = generateRequestId()
    const chatId = body.conversationId ?? streamId
    const toolCallId = generateRequestId()

    const transformed = new ReadableStream<Uint8Array>({
      async start(controller) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        let buffer = ''
        let sawSsePrefix = false
        let seq = 0
        let accumulatedAssistantText = ''
        let hasEmittedToolResult = false
        const displayedStatusLines: string[] = []
        let statusRotationTimer: ReturnType<typeof setInterval> | null = null

        const emitEvent = (event: TextEnvelope | CompleteEnvelope | ToolEnvelope) => {
          controller.enqueue(encoder.encode(toSseDataLine(event)))
        }

        const stopStatusRotation = () => {
          if (statusRotationTimer) {
            clearInterval(statusRotationTimer)
            statusRotationTimer = null
          }
        }

        const nextSeq = () => {
          seq += 1
          return seq
        }

        const emitTextEvent = (text: string) => {
          if (!text) return
          stopStatusRotation()
          accumulatedAssistantText += text
          const event: TextEnvelope = {
            v: 1,
            type: 'text',
            seq: nextSeq(),
            ts: new Date().toISOString(),
            stream: {
              streamId,
              chatId,
              cursor: String(seq),
            },
            trace: {
              requestId,
            },
            payload: {
              channel: 'assistant',
              text,
            },
          }
          emitEvent(event)
        }
        const emitToolResultEvent = (params: {
          status: 'success' | 'error'
          success: boolean
          output?: unknown
          error?: string
          scope?: {
            lane: 'subagent'
            agentId?: string
            parentToolCallId?: string
          }
        }) => {
          if (hasEmittedToolResult) return
          hasEmittedToolResult = true
          emitEvent({
            v: 1,
            type: 'tool',
            seq: nextSeq(),
            ts: new Date().toISOString(),
            stream: { streamId, chatId, cursor: String(seq) },
            trace: { requestId },
            ...(params.scope ? { scope: params.scope } : {}),
            payload: {
              toolCallId,
              toolName: 'run',
              executor: 'sim',
              mode: 'async',
              phase: 'result',
              status: params.status,
              success: params.success,
              ...(params.output !== undefined ? { output: params.output } : {}),
              ...(params.error ? { error: params.error } : {}),
            },
          })
        }

        const statusMessages = getDynamicStatusMessages(body.input)
        const runScope = {
          lane: 'subagent' as const,
          agentId: 'run',
        }

        const emitToolExecutingStatus = (title: string) => {
          if (hasEmittedToolResult) return
          emitEvent({
            v: 1,
            type: 'tool',
            seq: nextSeq(),
            ts: new Date().toISOString(),
            stream: { streamId, chatId, cursor: String(seq) },
            trace: { requestId },
            scope: runScope,
            payload: {
              toolCallId,
              toolName: 'run',
              arguments: { request: body.input },
              executor: 'sim',
              mode: 'async',
              phase: 'call',
              status: 'executing',
              ui: {
                title,
                phaseLabel: 'Run Agent',
                icon: 'play',
                internal: true,
              },
            },
          })
        }

        const appendStatusMessage = (message: string) => {
          displayedStatusLines.push(message)
          emitToolExecutingStatus(displayedStatusLines.join('\n'))
        }

        const advanceStatusMessage = () => {
          const nextIndex = displayedStatusLines.length
          if (nextIndex >= statusMessages.length) {
            stopStatusRotation()
            return
          }
          appendStatusMessage(statusMessages[nextIndex]!)
        }

        appendStatusMessage(statusMessages[0] ?? 'Running the workflow and collecting details...')

        if (statusMessages.length > 1) {
          statusRotationTimer = setInterval(advanceStatusMessage, STATUS_ROTATION_MS)
        }

        const processRawFrame = (rawFrame: string) => {
          const frame = rawFrame.trim()
          if (!frame) return

          if (frame.includes('\ndata:') || frame.startsWith('data:')) {
            sawSsePrefix = true
            const dataLines = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
            const mergedData = dataLines.join('\n').trim()
            const text = extractTextFromUpstreamData(mergedData, body.selectedOutputs)
            emitTextEvent(text)
            return
          }

          if (!sawSsePrefix) {
            const text = extractTextFromUpstreamData(frame, body.selectedOutputs)
            emitTextEvent(text)
          }
        }

        try {
          const upstream = await fetchStreamingPost(executeUrl, {
            headers: {
              'X-API-Key': apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              input: body.input,
              ...(body.conversationId ? { conversationId: body.conversationId } : {}),
              stream: true,
              selectedOutputs: body.selectedOutputs,
              email: session.user.email,
              userId: session.user.id,
            }),
          })

          if (!upstream.ok) {
            logger.error('Workflow execution API returned non-OK status', {
              userId,
              workflowId: body.workflowId,
              status: upstream.status,
              error: upstream.errorText,
            })
            emitTextEvent('Failed to execute workflow request. Please try again.')
            emitToolResultEvent({
              status: 'error',
              success: false,
              error: `Workflow request failed with status ${upstream.status}`,
              scope: runScope,
            })
            emitEvent({
              v: 1,
              type: 'complete',
              seq: nextSeq(),
              ts: new Date().toISOString(),
              stream: { streamId, chatId, cursor: String(seq) },
              trace: { requestId },
              payload: { status: 'complete' },
            })
            return
          }

          const upstreamBody = upstream.body
          if (!upstreamBody) {
            logger.error('Workflow execution API returned empty stream body', {
              userId,
              workflowId: body.workflowId,
            })
            emitTextEvent('Workflow response stream was empty.')
            emitToolResultEvent({
              status: 'error',
              success: false,
              error: 'Workflow response stream was empty.',
              scope: runScope,
            })
            emitEvent({
              v: 1,
              type: 'complete',
              seq: nextSeq(),
              ts: new Date().toISOString(),
              stream: { streamId, chatId, cursor: String(seq) },
              trace: { requestId },
              payload: { status: 'complete' },
            })
            return
          }

          reader = upstreamBody.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const frames = buffer.split('\n\n')
            buffer = frames.pop() ?? ''
            for (const frame of frames) {
              processRawFrame(frame)
            }
          }

          const trailing = buffer.trim()
          processRawFrame(trailing)
          emitToolResultEvent({
            status: 'success',
            success: true,
            output: {
              message: 'Workflow execution completed.',
            },
            scope: runScope,
          })
          emitEvent({
            v: 1,
            type: 'complete',
            seq: nextSeq(),
            ts: new Date().toISOString(),
            stream: { streamId, chatId, cursor: String(seq) },
            trace: { requestId },
            payload: { status: 'complete' },
          })
        } catch (error) {
          emitToolResultEvent({
            status: 'error',
            success: false,
            error: error instanceof Error ? error.message : String(error),
            scope: runScope,
          })
          emitEvent({
            v: 1,
            type: 'complete',
            seq: nextSeq(),
            ts: new Date().toISOString(),
            stream: { streamId, chatId, cursor: String(seq) },
            trace: { requestId },
            payload: { status: 'complete' },
          })
          logger.error('Failed to transform upstream workflow stream', {
            userId,
            workflowId: body.workflowId,
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          stopStatusRotation()
          if (body.conversationId) {
            try {
              await persistWorkflowChatTurn({
                chatId: body.conversationId,
                userId,
                userInput: body.input,
                assistantOutput: accumulatedAssistantText,
                requestId,
              })
            } catch (error) {
              logger.error('Failed to persist workflow execution chat turn', {
                userId,
                chatId: body.conversationId,
                workflowId: body.workflowId,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
          if (reader) {
            try {
              await reader.cancel()
            } catch {}
          }
          try {
            controller.close()
          } catch {}
        }
      },
    })

    return new Response(transformed, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    logger.error('Unexpected error executing workflow', {
      userId,
      workflowId: body.workflowId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
