import { db } from '@sim/db'
import { chat, deployedChat, workflowExecutionLogs, workflowQueries } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { deployedChatPostContract, goldenQueriesSchema } from '@/lib/api/contracts/chats'
import { parseRequest } from '@/lib/api/server'
import { getSession } from '@/lib/auth'
import { releaseExecutionSlot } from '@/lib/billing/calculations/usage-reservation'
import { formatChartDeployOutputForChat } from '@/lib/chart-generation/echarts-option'
import { getAgentDepartmentLabel } from '@/lib/chat/arena-departments'
import { extractGeneratedImagesFromData } from '@/lib/chat/assistant-assets'
import {
  toPersistedChatAttachment,
  updateExecutionHistoryData,
} from '@/lib/chat/history-persistence'
import { admissionRejectedResponse, tryAdmit } from '@/lib/core/admission/gate'
import { env } from '@/lib/core/config/env'
import {
  enforceIpRateLimitWithIndependentBackstop,
  enforceResourceRateLimit,
  type TokenBucketConfig,
} from '@/lib/core/rate-limiter'
import { RATE_LIMITS } from '@/lib/core/rate-limiter/types'
import { validateAuthToken } from '@/lib/core/security/deployment'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { preprocessExecution } from '@/lib/execution/preprocessing'
import { LoggingSession } from '@/lib/logs/execution/logging-session'
import { ChatFiles } from '@/lib/uploads'
import { loadDeployedWorkflowState } from '@/lib/workflows/persistence/utils'
import { formatOutputSelector } from '@/lib/workflows/streaming/output-selector'
import type { InputFormatField } from '@/lib/workflows/types'
import { getWorkspaceIdsForUser } from '@/lib/workspaces/permissions/utils'
import { setChatAuthCookie, validateChatAuth } from '@/app/api/chat/utils'
import { createCodedErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'

const logger = createLogger('ChatIdentifierAPI')

function isRenderableImageUrlString(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  return (
    (trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('/api/files/serve/')) &&
    (/\.(png|jpg|jpeg|gif|webp)(\?|#|%|$)/i.test(trimmed) ||
      trimmed.includes('agent-generated-images') ||
      trimmed.includes('/api/files/serve/'))
  )
}

function stripImageOnlyStructuredText(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) {
    return ''
  }

  const parseImageUrlArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === 'string' && isRenderableImageUrlString(item)
        )
      : []

  if (trimmed.startsWith('[')) {
    try {
      if (parseImageUrlArray(JSON.parse(trimmed)).length > 0) {
        return ''
      }
    } catch {
      // fall through
    }
  }

  if (trimmed.startsWith('```')) {
    const fencedMatch = trimmed.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i)
    if (fencedMatch?.[1]) {
      try {
        if (parseImageUrlArray(JSON.parse(fencedMatch[1])).length > 0) {
          return ''
        }
      } catch {
        // fall through
      }
    }
  }

  const nonEmptyLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (nonEmptyLines.length > 0 && nonEmptyLines.every((line) => isRenderableImageUrlString(line))) {
    return ''
  }

  return content
}
interface ChatConfigSource {
  id: string
  title: string
  description: string | null
  customizations: unknown
  authType: string | null
  outputConfigs: unknown
  inputFormat?: unknown
  userWorkspaceIds?: unknown
  includeThinking: boolean
  includeToolCalls: boolean
}

function toChatConfigResponse(deployment: ChatConfigSource) {
  return {
    id: deployment.id,
    title: deployment.title,
    description: deployment.description,
    customizations: deployment.customizations,
    authType: deployment.authType,
    outputConfigs: deployment.outputConfigs,
    inputFormat: deployment.inputFormat,
    userWorkspaceIds: deployment.userWorkspaceIds,
    includeThinking: deployment.includeThinking,
    includeToolCalls: deployment.includeToolCalls,
  }
}

const sanitizeGoldenQueries = (queries?: Array<{ id?: string; query: string }>) => {
  if (!Array.isArray(queries)) return []
  return queries
    .map((item) => ({ ...item, query: item.query.trim() }))
    .filter((item) => item.query.length > 0)
}

async function fetchGoldenQueries(workflowId: string) {
  const rows = await db
    .select({ id: workflowQueries.id, query: workflowQueries.query })
    .from(workflowQueries)
    .where(and(eq(workflowQueries.workflowId, workflowId), eq(workflowQueries.deleted, false)))
    .orderBy(asc(workflowQueries.priority), asc(workflowQueries.createdAt))
  return rows
}

async function replaceWorkflowQueries({
  workflowId,
  userId,
  queries,
}: {
  workflowId: string
  userId: string
  queries: Array<{ id?: string; query: string }>
}) {
  await db.transaction(async (tx) => {
    await tx.delete(workflowQueries).where(eq(workflowQueries.workflowId, workflowId))

    if (queries.length === 0) return

    await tx.insert(workflowQueries).values(
      queries.map((item, index) => ({
        id: item.id ?? generateId(),
        userId,
        workflowId,
        query: item.query,
        priority: index,
      }))
    )
  })
}

async function softDeleteWorkflowQueries({
  workflowId,
  keepQueries,
}: {
  workflowId: string
  keepQueries: Array<{ id?: string; query: string }>
}) {
  const keepIds = keepQueries.map((item) => item.id).filter(Boolean) as string[]
  const rows = await db
    .select({ id: workflowQueries.id, query: workflowQueries.query })
    .from(workflowQueries)
    .where(and(eq(workflowQueries.workflowId, workflowId), eq(workflowQueries.deleted, false)))
  const toDeleteIds = rows.filter((row) => !keepIds.includes(row.id)).map((row) => row.id)
  if (toDeleteIds.length === 0) return
  await db
    .update(workflowQueries)
    .set({ deleted: true, updatedAt: new Date() })
    .where(inArray(workflowQueries.id, toDeleteIds))

  await db.transaction(async (tx) => {
    for (const [index, item] of keepQueries.entries()) {
      if (!item.id) continue
      await tx
        .update(workflowQueries)
        .set({ priority: index, updatedAt: new Date() })
        .where(eq(workflowQueries.id, item.id))
    }
  })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CHAT_MAX_REQUEST_BYTES = Number.parseInt(env.CHAT_MAX_REQUEST_BYTES, 10) || 220 * 1024 * 1024

/** A sustained per-minute rate, with the 2x burst allowance the plan buckets use. */
function executionsPerMinute(perMinute: number): TokenBucketConfig {
  return { maxTokens: perMinute * 2, refillRate: perMinute, refillIntervalMs: 60_000 }
}

/**
 * What one deployed chat may spend of its owner's workspace allowance.
 *
 * A chat execution debits the workspace `sync` counter, which is the same
 * counter the owner's API, webhook and scheduled runs draw from. So this
 * ceiling only does its job while it sits *below* that counter: above it, a
 * flood empties the shared budget before this bucket ever refuses, and the
 * billing attack becomes an availability attack on unrelated production
 * workloads.
 *
 * Derived from the plan table rather than picked, because no fixed number holds
 * that invariant — the rates differ per plan and every one is operator
 * overridable through `RATE_LIMIT_*_SYNC`. A fraction of the smallest
 * configured rate keeps a public chat under the shared budget on every plan and
 * cannot drift if one of those defaults changes.
 *
 * The floor is deliberately shared by all plans for now. Sizing the slice to
 * the *payer's* own plan needs the subscription, which `preprocessExecution`
 * resolves a few lines after this runs, not here.
 *
 * A configured rate of `1` is the one value where this lands equal to the plan
 * rather than under it, because no positive integer is below 1. It is inert:
 * a workspace allowed one execution per minute has no capacity left to starve,
 * and the two buckets then exhaust together rather than one masking the other.
 */
const CHAT_EXECUTION_RATE_PER_MINUTE = Math.max(
  1,
  Math.floor(Math.min(...Object.values(RATE_LIMITS).map((plan) => plan.sync.refillRate)) * 0.8)
)

const CHAT_EXECUTION_LIMIT = executionsPerMinute(CHAT_EXECUTION_RATE_PER_MINUTE)

/**
 * Executions one client IP may drive against a single deployed chat.
 *
 * Half the per-deployment rate, so a single source can never consume the whole
 * allowance and leave the rest of the audience with none. It is above one
 * person's chat cadence but not above a busy office behind one NAT — which
 * costs little in practice, since traffic that heavy from one address would
 * meet the per-deployment ceiling moments later anyway.
 */
const CHAT_EXECUTION_IP_LIMIT = executionsPerMinute(
  Math.max(1, Math.floor(CHAT_EXECUTION_RATE_PER_MINUTE / 2))
)

export const POST = withRouteHandler(
  async (request: NextRequest, context: { params: Promise<{ identifier: string }> }) => {
    const { identifier } = await context.params
    const requestId = generateRequestId()

    const ticket = tryAdmit()
    if (!ticket) {
      return admissionRejectedResponse()
    }

    try {
      const parsed = await parseRequest(deployedChatPostContract, request, context, {
        maxBodyBytes: CHAT_MAX_REQUEST_BYTES,
        validationErrorResponse: (err) => {
          const message = err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
          return createCodedErrorResponse(
            `Invalid request body: ${message}`,
            400,
            'VALIDATION_ERROR'
          )
        },
        invalidJsonResponse: () => createCodedErrorResponse('Invalid request body', 400),
      })
      if (!parsed.success) return parsed.response
      const parsedBody = parsed.data.body

      const deploymentResult = await db
        .select({
          id: chat.id,
          title: chat.title,
          description: chat.description,
          customizations: chat.customizations,
          workflowId: chat.workflowId,
          userId: chat.userId,
          isActive: chat.isActive,
          authType: chat.authType,
          password: chat.password,
          allowedEmails: chat.allowedEmails,
          outputConfigs: chat.outputConfigs,
          includeThinking: chat.includeThinking,
          includeToolCalls: chat.includeToolCalls,
        })
        .from(chat)
        .where(and(eq(chat.identifier, identifier), isNull(chat.archivedAt)))
        .limit(1)

      if (deploymentResult.length === 0) {
        logger.warn(`[${requestId}] Chat not found for identifier: ${identifier}`)
        return createCodedErrorResponse('Chat not found', 404)
      }

      const deployment = deploymentResult[0]

      if (!deployment.isActive) {
        logger.warn(`[${requestId}] Chat is not active: ${identifier}`)
        return createCodedErrorResponse('This chat is currently unavailable', 403)
      }

      const authResult = await validateChatAuth(requestId, deployment, request, parsedBody)
      if (!authResult.authorized) {
        const response = createCodedErrorResponse(
          authResult.error || 'Authentication required',
          authResult.status || 401
        )
        if (authResult.status === 429 && authResult.retryAfterMs !== undefined) {
          response.headers.set('Retry-After', String(Math.ceil(authResult.retryAfterMs / 1000)))
        }
        return response
      }

      // Store chat details in deployed_chat table if chatId is provided
      // Ensures each chatId is added only once, even with concurrent requests
      if (parsedBody.chatId) {
        try {
          const chatId = parsedBody.chatId
          logger.debug(`[${requestId}] Processing chatId: ${chatId}`)

          // Get the executing user ID from session
          let executingUserId: string | undefined
          try {
            const session = await getSession()
            executingUserId = session?.user?.id
            logger.debug(`[${requestId}] Executing user ID from session:`, executingUserId)
          } catch (error) {
            logger.debug(
              `[${requestId}] Could not get session (user may not be authenticated):`,
              error
            )
          }

          // Check if chatId already exists in deployed_chat table
          // Using both chatId and workflowId to ensure proper context
          const existingChat = await db
            .select({ id: deployedChat.id })
            .from(deployedChat)
            .where(eq(deployedChat.chatId, chatId))
            .limit(1)

          if (existingChat.length > 0) {
            // ChatId already exists - just update the timestamp and user ID
            const existingChatId = existingChat[0].id
            logger.debug(`[${requestId}] ChatId already exists, updating timestamp: ${chatId}`)

            await db
              .update(deployedChat)
              .set({
                updatedAt: new Date(),
                executingUserId: executingUserId || null,
              })
              .where(eq(deployedChat.id, existingChatId))

            logger.debug(`[${requestId}] Successfully updated existing chat: ${chatId}`)
          } else {
            // ChatId doesn't exist - create a new record
            // Prefer Start Block input values for title; otherwise use first 5 words of input
            const startBlockValues =
              parsedBody.startBlockInputs && typeof parsedBody.startBlockInputs === 'object'
                ? Object.values(parsedBody.startBlockInputs)
                    .filter((value) => value !== undefined && value !== null)
                    .map((value) => {
                      const stringValue =
                        typeof value === 'string' ? value.trim() : `${value}`.trim()
                      return stringValue
                    })
                    .filter((value) => value.length > 0)
                : []

            const words = parsedBody.input?.trim().split(/\s+/).filter(Boolean) || []
            const title =
              startBlockValues.length > 0
                ? startBlockValues.join(', ')
                : words.slice(0, 5).join(' ') || 'New Chat'

            const deployedChatId = generateId()
            const now = new Date()

            logger.debug(`[${requestId}] Creating new deployed_chat record:`, {
              id: deployedChatId,
              chatId,
              title,
              workflowId: identifier,
              executingUserId,
            })

            try {
              await db.insert(deployedChat).values({
                id: deployedChatId,
                chatId,
                title,
                workflowId: identifier,
                executingUserId,
                createdAt: now,
                updatedAt: now,
              })

              logger.info(`[${requestId}] Successfully created new chat record: ${chatId}`)
            } catch (insertError: any) {
              // Handle race condition: if another request created the record between our check and insert
              if (
                insertError?.code === '23505' || // PostgreSQL unique violation
                (insertError instanceof Error && insertError.message.includes('unique'))
              ) {
                logger.debug(
                  `[${requestId}] Race condition detected - chatId was created by another request: ${chatId}`
                )

                // Verify the record exists and update it
                const raceConditionCheck = await db
                  .select({ id: deployedChat.id })
                  .from(deployedChat)
                  .where(eq(deployedChat.chatId, chatId))
                  .limit(1)

                if (raceConditionCheck.length > 0) {
                  await db
                    .update(deployedChat)
                    .set({
                      updatedAt: new Date(),
                      executingUserId: executingUserId || null,
                    })
                    .where(eq(deployedChat.id, raceConditionCheck[0].id))

                  logger.debug(`[${requestId}] Updated chat record after race condition: ${chatId}`)
                }
              } else {
                // Re-throw if it's a different error
                throw insertError
              }
            }
          }
        } catch (error: any) {
          // Log error but don't fail the request - chat functionality should continue
          logger.error(`[${requestId}] Error storing chat details in deployed_chat table:`, {
            message: error.message,
            code: error.code,
            chatId: parsedBody.chatId,
          })
        }
      } else {
        logger.debug(`[${requestId}] No chatId (payload) provided in request body`)
      }

      const {
        input,
        password,
        email,
        conversationId,
        chatId: payload,
        files,
        startBlockInputs,
      } = parsedBody

      // Get userId from session for external chat API requests
      const session = await getSession()
      const userId = session?.user?.id || null

      if ((password || email) && !input) {
        const response = createSuccessResponse(toChatConfigResponse(deployment))

        if (deployment.authType === 'password') {
          await setChatAuthCookie(response, deployment)
        } else if (deployment.authType === 'email') {
          const verifiedEmail = authResult.authenticatedEmail ?? email
          if (verifiedEmail) {
            await setChatAuthCookie(response, deployment, verifiedEmail)
          }
        }

        return response
      }

      // Check if we have any input: either input field, files, or startBlockInputs with values
      const hasStartBlockInputs =
        startBlockInputs &&
        typeof startBlockInputs === 'object' &&
        Object.keys(startBlockInputs).length > 0
      const hasStartBlockInputValues =
        hasStartBlockInputs &&
        Object.values(startBlockInputs).some(
          (value) => value !== null && value !== undefined && value !== ''
        )

      if (!input && (!files || files.length === 0) && !hasStartBlockInputValues) {
        return createCodedErrorResponse('No input provided', 400)
      }

      // Both buckets apply regardless of the chat's auth type: an email or SSO
      // visitor is still not the payer.
      const ipLimited = await enforceIpRateLimitWithIndependentBackstop(
        'chat-execute',
        request,
        CHAT_EXECUTION_IP_LIMIT,
        deployment.id
      )
      if (ipLimited) return ipLimited

      const deploymentLimited = await enforceResourceRateLimit(
        'chat-execute',
        deployment.id,
        CHAT_EXECUTION_LIMIT
      )
      if (deploymentLimited) return deploymentLimited

      const executionId = generateId()

      const loggingSession = new LoggingSession(
        deployment.workflowId,
        executionId,
        'chat',
        requestId
      )

      const preprocessResult = await preprocessExecution({
        workflowId: deployment.workflowId,
        userId: deployment.userId,
        // Whoever deployed this chat, not whoever is talking to it.
        userIdIsStoredReference: true,
        triggerType: 'chat',
        executionId,
        requestId,
        checkRateLimit: true,
        checkDeployment: true,
        loggingSession,
      })

      if (!preprocessResult.success) {
        logger.warn(`[${requestId}] Preprocessing failed: ${preprocessResult.error?.message}`)
        return createCodedErrorResponse(
          preprocessResult.error?.message || 'Failed to process request',
          preprocessResult.error?.statusCode || 500
        )
      }

      const { actorUserId, billingAttribution, workflowRecord } = preprocessResult
      const executionActor = preprocessResult.executionActor
      const resolvedActorUserId = actorUserId!
      const workspaceId = workflowRecord?.workspaceId
      if (!workspaceId) {
        logger.error(`[${requestId}] Workflow ${deployment.workflowId} has no workspaceId`)
        // preprocessExecution reserved a billing concurrency slot; release it on
        // this early exit since no LoggingSession will finalize to free it.
        await releaseExecutionSlot(executionId)
        return createCodedErrorResponse('Workflow has no associated workspace', 500)
      }

      // Format startBlockInputs into initialInput format
      // Format: variable1: Value entered by User\nvariable2: value entered by User
      let formattedInitialInput = input || ''
      if (startBlockInputs && typeof startBlockInputs === 'object') {
        const startBlockInputLines: string[] = []
        for (const [key, value] of Object.entries(startBlockInputs)) {
          // Skip reserved fields and empty values
          if (key === 'input' || key === 'conversationId' || key === 'files') {
            continue
          }
          if (value !== null && value !== undefined && value !== '') {
            const formattedValue = typeof value === 'string' ? value : String(value)
            startBlockInputLines.push(`${key}: ${formattedValue}`)
          }
        }
        if (startBlockInputLines.length > 0) {
          const startBlockInputsFormatted = startBlockInputLines.join('\n')
          formattedInitialInput = formattedInitialInput
            ? `${formattedInitialInput}\n${startBlockInputsFormatted}`
            : startBlockInputsFormatted
        }
      }

      // Start logging session with chat metadata
      await loggingSession.safeStart({
        userId: userId || resolvedActorUserId,
        actorUserId: resolvedActorUserId,
        billingAttribution,
        workspaceId,
        variables: {},
        isExternalChat: true,
        chatId: payload || conversationId || undefined,
        conversationId: conversationId || undefined,
        initialInput: formattedInitialInput || undefined,
        executionActor,
      })

      try {
        const selectedOutputs: string[] = []
        if (deployment.outputConfigs && Array.isArray(deployment.outputConfigs)) {
          for (const config of deployment.outputConfigs) {
            const outputId = formatOutputSelector(
              config.blockId,
              config.path || 'content',
              config.workflowId
            )
            selectedOutputs.push(outputId)
          }
        }

        const { createStreamingResponse, agentStreamProtocolResponseHeaders } = await import(
          '@/lib/workflows/streaming/streaming'
        )
        const { shouldEmitAgentStreamEvents } = await import(
          '@/lib/workflows/streaming/agent-stream-protocol'
        )
        const { executeWorkflow } = await import('@/lib/workflows/executor/execute-workflow')
        const { SSE_HEADERS } = await import('@/lib/core/utils/sse')

        const workflowInput: any = { input, conversationId }

        // Merge additional Start Block inputs (custom fields from inputFormat)
        // Always merge to ensure all Start Block fields are included, even if empty
        if (startBlockInputs && typeof startBlockInputs === 'object') {
          Object.assign(workflowInput, startBlockInputs)
          logger.debug(
            `[${requestId}] Merged ${Object.keys(startBlockInputs).length} Start Block inputs`
          )
        } else {
          // Even if startBlockInputs is not provided, ensure empty values for consistency
          // The client should always send startBlockInputs, but this is a safety check
          logger.debug(`[${requestId}] No Start Block inputs provided in request`)
        }

        if (files && Array.isArray(files) && files.length > 0) {
          const executionContext = {
            workspaceId,
            workflowId: deployment.workflowId,
            executionId,
          }

          try {
            const uploadedFiles = await ChatFiles.processChatFiles(
              files,
              executionContext,
              requestId,
              deployment.userId
            )

            if (uploadedFiles.length > 0) {
              workflowInput.files = uploadedFiles
              await updateExecutionHistoryData(executionId, {
                userAttachments: uploadedFiles.map(toPersistedChatAttachment),
              })
              logger.info(`[${requestId}] Successfully processed ${uploadedFiles.length} files`)
            }
          } catch (fileError: any) {
            logger.error(`[${requestId}] Failed to process chat files:`, fileError)

            await loggingSession.safeStart({
              userId: resolvedActorUserId,
              actorUserId: resolvedActorUserId,
              billingAttribution,
              workspaceId,
              variables: {},
              conversationId: undefined,
              executionActor,
            })

            await loggingSession.safeCompleteWithError({
              error: {
                message: `File upload failed: ${fileError.message || 'Unable to process uploaded files'}`,
                stackTrace: fileError.stack,
              },
              traceSpans: [],
              skipCost: true,
            })

            throw fileError
          }
        }

        const workflowForExecution = {
          id: deployment.workflowId,
          /**
           * The workflow owner, not the chat's creator: `executeWorkflow` reads this
           * one field to set `workflowUserId`, the personal-environment fallback for
           * runs with no identifiable caller. `chat.userId` records who deployed the
           * chat and is never maintained as an execution identity — member removal
           * reassigns `workflow.userId` to keep it an active workspace identity and
           * has no equivalent for the chat row — so reading it here made deployed
           * chat resolve a pointer that every other trigger had already repaired.
           */
          userId: workflowRecord.userId,
          workspaceId,
          isDeployed: workflowRecord?.isDeployed ?? false,
          variables: (workflowRecord?.variables as Record<string, unknown>) ?? undefined,
        }

        const { includeThinking, includeToolCalls } = deployment
        const agentEvents = shouldEmitAgentStreamEvents({
          includeThinking,
          includeToolCalls,
          requestHeaders: request.headers,
        })
        const originalStream = await createStreamingResponse({
          requestId,
          streamConfig: {
            selectedOutputs,
            isSecureMode: true,
            workflowTriggerType: 'chat',
            sessionUserId: userId ?? undefined,
            includeThinking,
            includeToolCalls,
          },
          executionId,
          workspaceId,
          workflowId: deployment.workflowId,
          userId: resolvedActorUserId,
          requestSignal: request.signal,
          requestHeaders: request.headers,
          executeFn: async ({ onStream, onBlockComplete, abortSignal, sessionUserId }) =>
            executeWorkflow(
              workflowForExecution,
              requestId,
              workflowInput,
              resolvedActorUserId,
              {
                enabled: true,
                principal: {
                  kind: 'system',
                  serviceId: 'chat',
                  workspaceId,
                  workflowId: deployment.workflowId,
                  ...(authResult.authenticatedEmail
                    ? {
                        subject: {
                          kind: 'authenticated_email' as const,
                          email: authResult.authenticatedEmail,
                        },
                      }
                    : {}),
                },
                selectedOutputs,
                isSecureMode: true,
                workflowTriggerType: 'chat',
                onStream,
                onBlockComplete: (blockId, data) =>
                  onBlockComplete(blockId, data.output, data.outputBlockId),
                skipLoggingComplete: true,
                sessionUserId: sessionUserId ?? undefined,
                abortSignal,
                executionMode: 'stream',
                billingAttribution,
                includeThinking,
                includeToolCalls,
                agentEvents,
              },
              executionId
            ),
        })

        // Wrap the stream to capture final output and update workflowExecutionLogs
        const wrappedStream = new ReadableStream({
          async start(controller) {
            const reader = originalStream.getReader()
            const decoder = new TextDecoder()
            const encoder = new TextEncoder()
            let buffer = ''
            let accumulatedContent = ''

            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break

                // Decode and process the chunk
                const chunk = decoder.decode(value, { stream: true })
                buffer += chunk

                // Process complete SSE messages
                const lines = buffer.split('\n\n')
                buffer = lines.pop() || ''

                for (const line of lines) {
                  if (!line.trim() || !line.startsWith('data: ')) {
                    controller.enqueue(encoder.encode(`${line}\n\n`))
                    continue
                  }

                  const data = line.substring(6).trim()
                  if (data === '[DONE]') {
                    controller.enqueue(encoder.encode(`${line}\n\n`))
                    continue
                  }

                  try {
                    const json = JSON.parse(data)
                    const { event, data: eventData, chunk: contentChunk } = json

                    // Capture streaming content chunks
                    if (contentChunk) {
                      accumulatedContent += contentChunk
                    }

                    // Handle final event - format output and update log
                    if (event === 'final' && eventData) {
                      const finalData = eventData as {
                        success: boolean
                        error?: string | { message?: string }
                        output?: Record<string, Record<string, any>>
                      }

                      const getOutputValue = (blockOutputs: Record<string, any>, path?: string) => {
                        if (!path || path === 'content') {
                          if (blockOutputs.content !== undefined) return blockOutputs.content
                          if (blockOutputs.result !== undefined) return blockOutputs.result
                          return blockOutputs
                        }
                        if (blockOutputs[path] !== undefined) {
                          return blockOutputs[path]
                        }
                        if (path.includes('.')) {
                          return path.split('.').reduce<any>((current, segment) => {
                            if (current && typeof current === 'object' && segment in current) {
                              return current[segment]
                            }
                            return undefined
                          }, blockOutputs)
                        }
                        return undefined
                      }

                      /** Check if value is a knowledge base results array (documentId, documentName, content, chunkIndex) */
                      const isKnowledgeResultsArray = (
                        value: unknown
                      ): value is Array<Record<string, unknown>> =>
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

                      const mapToKnowledgePayload = (value: Array<Record<string, unknown>>) =>
                        value.map((item) => ({
                          documentId: String(item.documentId),
                          documentName: String(item.documentName ?? item.documentId),
                          content: String(item.content),
                          chunkIndex: Number(item.chunkIndex),
                          ...(item.metadata && typeof item.metadata === 'object'
                            ? { metadata: item.metadata as Record<string, unknown> }
                            : {}),
                          ...(typeof item.similarity === 'number'
                            ? { similarity: item.similarity }
                            : {}),
                          ...(item.chunkId != null ? { chunkId: String(item.chunkId) } : {}),
                          ...(item.knowledgeBaseId != null
                            ? { knowledgeBaseId: String(item.knowledgeBaseId) }
                            : {}),
                          ...(item.workspaceId != null
                            ? {
                                workspaceId:
                                  item.workspaceId === null ? null : String(item.workspaceId),
                              }
                            : {}),
                        }))

                      let knowledgeResultsPayload: Array<{
                        documentId: string
                        documentName: string
                        content: string
                        chunkIndex: number
                        metadata?: Record<string, unknown>
                        similarity?: number
                        chunkId?: string
                        knowledgeBaseId?: string
                        workspaceId?: string | null
                      }> = []

                      if (finalData.output) {
                        const fromOutputConfig =
                          deployment.outputConfigs &&
                          Array.isArray(deployment.outputConfigs) &&
                          (() => {
                            const aggregated: Array<{
                              documentId: string
                              documentName: string
                              content: string
                              chunkIndex: number
                              metadata?: Record<string, unknown>
                              similarity?: number
                              chunkId?: string
                              knowledgeBaseId?: string
                              workspaceId?: string | null
                            }> = []
                            for (const config of deployment.outputConfigs) {
                              if (config.path === 'results') {
                                const blockOutputs = finalData.output[config.blockId]
                                if (!blockOutputs) continue
                                const value = getOutputValue(blockOutputs, config.path)
                                if (isKnowledgeResultsArray(value)) {
                                  aggregated.push(...mapToKnowledgePayload(value))
                                }
                              }
                            }
                            return aggregated.length > 0 ? aggregated : null
                          })()

                        if (Array.isArray(fromOutputConfig) && fromOutputConfig.length > 0) {
                          knowledgeResultsPayload = fromOutputConfig
                        } else {
                          for (const blockOutputs of Object.values(finalData.output)) {
                            if (!blockOutputs || typeof blockOutputs !== 'object') continue
                            const value = getOutputValue(blockOutputs, 'results')
                            if (isKnowledgeResultsArray(value)) {
                              knowledgeResultsPayload.push(...mapToKnowledgePayload(value))
                            }
                          }
                        }
                      }

                      if (knowledgeResultsPayload.length > 0) {
                        const knowledgeResultsEvent = JSON.stringify({
                          event: 'knowledgeResults',
                          data: knowledgeResultsPayload,
                        })
                        controller.enqueue(encoder.encode(`data: ${knowledgeResultsEvent}\n\n`))
                      }

                      let generatedImages: ReturnType<typeof extractGeneratedImagesFromData> = []
                      if (
                        deployment.outputConfigs &&
                        Array.isArray(deployment.outputConfigs) &&
                        finalData.output
                      ) {
                        for (const config of deployment.outputConfigs) {
                          const blockOutputs = finalData.output[config.blockId]
                          if (!blockOutputs) continue
                          const value = getOutputValue(blockOutputs, config.path)
                          generatedImages = extractGeneratedImagesFromData(value, generatedImages)
                        }
                      }

                      /** Minimal refs for history: one per chunk (document name + chunk index + chunk link). */
                      const knowledgeRefs =
                        knowledgeResultsPayload.length > 0
                          ? (() => {
                              const refs: Array<{
                                documentId: string
                                documentName: string
                                chunkId: string
                                chunkIndex: number
                                knowledgeBaseId: string
                                workspaceId: string | null
                              }> = []
                              for (const item of knowledgeResultsPayload) {
                                if (
                                  item.chunkId != null &&
                                  item.knowledgeBaseId != null &&
                                  item.workspaceId !== undefined &&
                                  typeof item.chunkIndex === 'number'
                                ) {
                                  refs.push({
                                    documentId: item.documentId,
                                    documentName: item.documentName || item.documentId,
                                    chunkId: String(item.chunkId),
                                    chunkIndex: item.chunkIndex,
                                    knowledgeBaseId: String(item.knowledgeBaseId),
                                    workspaceId:
                                      item.workspaceId === null ? null : String(item.workspaceId),
                                  })
                                }
                              }
                              return refs
                            })()
                          : []

                      let finalChatOutput = accumulatedContent.trim()

                      // Format final output based on outputConfigs (exclude raw "results" for knowledge block)
                      if (
                        deployment.outputConfigs &&
                        Array.isArray(deployment.outputConfigs) &&
                        finalData.output
                      ) {
                        const formatValue = (value: any): string | null => {
                          if (value === null || value === undefined) {
                            return null
                          }
                          if (extractGeneratedImagesFromData(value).length > 0) {
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

                        const formattedOutputs: string[] = []
                        for (const config of deployment.outputConfigs) {
                          const blockOutputs = finalData.output[config.blockId]
                          if (!blockOutputs) continue

                          const value = getOutputValue(blockOutputs, config.path)
                          if (config.path === 'results' && isKnowledgeResultsArray(value)) {
                            continue
                          }
                          const formatted = formatValue(value)
                          if (formatted) {
                            formattedOutputs.push(formatted)
                          }
                        }

                        if (formattedOutputs.length > 0) {
                          const trimmedStreamingContent = accumulatedContent.trim()
                          const uniqueOutputs = formattedOutputs.filter((output) => {
                            const trimmedOutput = output.trim()
                            if (!trimmedOutput) return false
                            if (
                              trimmedStreamingContent &&
                              trimmedOutput === trimmedStreamingContent
                            ) {
                              return false
                            }
                            return true
                          })

                          if (uniqueOutputs.length > 0) {
                            const combinedOutputs = uniqueOutputs.join('\n\n')
                            finalChatOutput = finalChatOutput
                              ? `${finalChatOutput}\n\n${combinedOutputs}`
                              : combinedOutputs
                          }
                        }
                      }

                      if (generatedImages.length > 0) {
                        finalChatOutput = stripImageOnlyStructuredText(finalChatOutput)
                        const imageUrls = generatedImages.map((image) => image.url).filter(Boolean)
                        if (imageUrls.length > 0) {
                          finalChatOutput = finalChatOutput
                            ? `${finalChatOutput}\n\n${imageUrls.join('\n')}`
                            : imageUrls.join('\n')
                        }
                      }

                      if (
                        finalChatOutput ||
                        knowledgeRefs.length > 0 ||
                        generatedImages.length > 0
                      ) {
                        // Update workflowExecutionLogs with final output and optional knowledgeRefs (for history)
                        try {
                          if (finalChatOutput) {
                            await db
                              .update(workflowExecutionLogs)
                              .set({ finalChatOutput })
                              .where(eq(workflowExecutionLogs.executionId, executionId))
                          }
                          if (knowledgeRefs.length > 0 || generatedImages.length > 0) {
                            await updateExecutionHistoryData(executionId, {
                              knowledgeRefs,
                              generatedImages,
                            })
                          }
                          logger.debug(
                            `[${requestId}] Updated finalChatOutput for execution ${executionId}`
                          )
                        } catch (updateError) {
                          logger.error(
                            `[${requestId}] Failed to update finalChatOutput:`,
                            updateError
                          )
                        }
                      }
                    }

                    // Pass through the original data
                    controller.enqueue(encoder.encode(`${line}\n\n`))
                  } catch {
                    // If parsing fails, just pass through the original line
                    controller.enqueue(encoder.encode(`${line}\n\n`))
                  }
                }
              }
            } catch (error) {
              logger.error(`[${requestId}] Error in stream wrapper:`, error)
              controller.error(error)
            } finally {
              reader.releaseLock()
              controller.close()
            }
          },
        })

        const streamResponse = new NextResponse(wrappedStream, {
          status: 200,
          headers: {
            ...SSE_HEADERS,
            ...agentStreamProtocolResponseHeaders({ requestHeaders: request.headers }),
          },
        })
        return streamResponse
      } catch (error: any) {
        logger.error(`[${requestId}] Error processing chat request:`, error)
        // Setup failed before the workflow stream took over slot release;
        // free the reserved billing slot (idempotent if already released).
        await releaseExecutionSlot(executionId)
        return createCodedErrorResponse(error.message || 'Failed to process request', 500)
      }
    } catch (error: any) {
      logger.error(`[${requestId}] Error processing chat request:`, error)
      return createCodedErrorResponse(error.message || 'Failed to process request', 500)
    } finally {
      ticket.release()
    }
  }
)

export const PATCH = withRouteHandler(
  async (request: NextRequest, { params }: { params: Promise<{ identifier: string }> }) => {
    const { identifier } = await params
    const requestId = generateRequestId()

    try {
      let parsedBody
      try {
        const rawBody = await request.json()
        const validation = goldenQueriesSchema.safeParse(rawBody)
        if (!validation.success) {
          const errorMessage = validation.error.issues
            .map((err) => `${err.path.join('.')}: ${err.message}`)
            .join(', ')
          return createCodedErrorResponse(`Invalid request body: ${errorMessage}`, 400)
        }
        parsedBody = validation.data
      } catch (_error) {
        return createCodedErrorResponse('Invalid request body', 400)
      }

      const deploymentResult = await db
        .select({
          id: chat.id,
          isActive: chat.isActive,
          authType: chat.authType,
          password: chat.password,
          allowedEmails: chat.allowedEmails,
          workflowId: chat.workflowId,
          userId: chat.userId,
        })
        .from(chat)
        .where(eq(chat.identifier, identifier))
        .limit(1)

      if (deploymentResult.length === 0) {
        logger.warn(`[${requestId}] Chat not found for identifier: ${identifier}`)
        return createCodedErrorResponse('Chat not found', 404)
      }

      const deployment = deploymentResult[0]
      if (!deployment.isActive) {
        logger.warn(`[${requestId}] Chat is not active: ${identifier}`)
        return createCodedErrorResponse('This chat is currently unavailable', 403)
      }

      const cookieName = `chat_auth_${deployment.id}`
      const authCookie = request.cookies.get(cookieName)
      if (
        deployment.authType !== 'public' &&
        (!authCookie?.value ||
          !(await validateAuthToken({ token: authCookie.value, resource: deployment })))
      ) {
        const authResult = await validateChatAuth(requestId, deployment, request)
        if (!authResult.authorized) {
          return createCodedErrorResponse(authResult.error || 'Authentication required', 401)
        }
      }

      const sanitizedQueries = sanitizeGoldenQueries(parsedBody.goldenQueries)
      const deleteMode = parsedBody.deleteMode ?? 'hard'

      if (deleteMode === 'soft') {
        await softDeleteWorkflowQueries({
          workflowId: deployment.workflowId,
          keepQueries: sanitizedQueries,
        })
      } else {
        await replaceWorkflowQueries({
          workflowId: deployment.workflowId,
          userId: deployment.userId,
          queries: sanitizedQueries,
        })
      }

      await db.update(chat).set({ updatedAt: new Date() }).where(eq(chat.id, deployment.id))

      return createSuccessResponse({ goldenQueries: sanitizedQueries })
    } catch (error: any) {
      logger.error(`[${requestId}] Error updating golden queries:`, error)
      return createCodedErrorResponse(error.message || 'Failed to update golden queries', 500)
    }
  }
)

export const GET = withRouteHandler(
  async (request: NextRequest, { params }: { params: Promise<{ identifier: string }> }) => {
    const { identifier } = await params
    const requestId = generateRequestId()

    try {
      const deploymentResult = await db
        .select({
          id: chat.id,
          title: chat.title,
          description: chat.description,
          customizations: chat.customizations,
          isActive: chat.isActive,
          workflowId: chat.workflowId,
          authType: chat.authType,
          password: chat.password,
          allowedEmails: chat.allowedEmails,
          outputConfigs: chat.outputConfigs,
          department: chat.department,
          deploymentType: chat.deploymentType,
          includeThinking: chat.includeThinking,
          includeToolCalls: chat.includeToolCalls,
        })
        .from(chat)
        .where(and(eq(chat.identifier, identifier), isNull(chat.archivedAt)))
        .limit(1)

      if (deploymentResult.length === 0) {
        logger.warn(`[${requestId}] Chat not found for identifier: ${identifier}`)
        return createCodedErrorResponse('Chat not found', 404)
      }

      const deployment = deploymentResult[0]

      if (!deployment.isActive) {
        logger.warn(`[${requestId}] Chat is not active: ${identifier}`)
        return createCodedErrorResponse('This chat is currently unavailable', 403)
      }

      if (deployment.deploymentType === 'app') {
        logger.warn(`[${requestId}] Chat is deployed as an external app: ${identifier}`)
        return createCodedErrorResponse('Chat not found', 404)
      }

      // Extract Start Block inputFormat for chat UI (before auth checks so it's available in all responses)
      let inputFormat: InputFormatField[] = []
      try {
        const deployedData = (await loadDeployedWorkflowState(
          deployment.workflowId
        )) as unknown as {
          blocks?: Record<string, unknown>
        }
        const blocks = Object.values(deployedData.blocks ?? {}) as Array<Record<string, unknown>>
        const startBlock = blocks.find(
          (block) => block.type === 'start_trigger' || block.type === 'starter'
        ) as { subBlocks?: Record<string, unknown> } | undefined
        const inputFormatValue = (startBlock?.subBlocks as any)?.inputFormat?.value as unknown
        if (inputFormatValue) {
          if (Array.isArray(inputFormatValue)) {
            inputFormat = inputFormatValue
              .filter((field) => {
                return (
                  field !== null &&
                  field !== undefined &&
                  typeof field === 'object' &&
                  !Array.isArray(field) &&
                  'name' in field &&
                  typeof (field as any).name === 'string'
                )
              })
              .map((field: any) => ({
                name: field.name,
                type: field.type,
                value: field.value,
              }))
          }
        }
      } catch (error) {
        logger.warn(`[${requestId}] Failed to extract inputFormat:`, error)
        // Continue without inputFormat - not critical for chat config
      }
      const goldenQueries = await fetchGoldenQueries(deployment.workflowId)
      const departmentLabel = await getAgentDepartmentLabel(deployment.department ?? null)

      /**
       * Helper function to build chat config response with inputFormat always included.
       * When userWorkspaceIds is provided (logged-in user with workspace access), KB "View in Knowledge Base" links are shown.
       */
      const buildChatConfigData = (userWorkspaceIds?: string[]) => {
        return {
          id: deployment.id,
          title: deployment.title,
          description: deployment.description,
          customizations: {
            ...(deployment.customizations ?? {}),
            goldenQueries,
          },
          authType: deployment.authType,
          outputConfigs: deployment.outputConfigs,
          inputFormat, // Always included in successful responses
          department: departmentLabel, // Department in label format
          includeThinking: deployment.includeThinking ?? false,
          includeToolCalls: deployment.includeToolCalls ?? false,
          ...(userWorkspaceIds && userWorkspaceIds.length > 0 && { userWorkspaceIds }),
        }
      }

      const cookieName = `chat_auth_${deployment.id}`
      const authCookie = request.cookies.get(cookieName)

      if (
        deployment.authType !== 'public' &&
        deployment.authType !== 'sso' &&
        authCookie?.value &&
        (await validateAuthToken({ token: authCookie.value, resource: deployment }))
      ) {
        let userWorkspaceIds: string[] | undefined
        try {
          const session = await getSession()
          if (session?.user?.id) {
            userWorkspaceIds = await getWorkspaceIdsForUser(session.user.id)
          }
        } catch {
          // Non-fatal; proceed without userWorkspaceIds
        }
        return createSuccessResponse(buildChatConfigData(userWorkspaceIds))
      }

      const authResult = await validateChatAuth(requestId, deployment, request)
      if (!authResult.authorized) {
        logger.info(
          `[${requestId}] Authentication required for chat: ${identifier}, type: ${deployment.authType}`
        )
        return createCodedErrorResponse(authResult.error || 'Authentication required', 401)
      }

      let userWorkspaceIds: string[] | undefined
      try {
        const session = await getSession()
        if (session?.user?.id) {
          userWorkspaceIds = await getWorkspaceIdsForUser(session.user.id)
        }
      } catch {
        // Non-fatal; proceed without userWorkspaceIds
      }

      const response = createSuccessResponse(buildChatConfigData(userWorkspaceIds))

      if (deployment.authType === 'password') {
        await setChatAuthCookie(response, deployment)
      } else if (deployment.authType === 'email' && authResult.authenticatedEmail) {
        await setChatAuthCookie(response, deployment, authResult.authenticatedEmail)
      }

      // return addCorsHeaders(response, request)
      return response
    } catch (error: any) {
      logger.error(`[${requestId}] Error fetching chat info:`, error)
      return createCodedErrorResponse(error.message || 'Failed to fetch chat information', 500)
    }
  }
)
