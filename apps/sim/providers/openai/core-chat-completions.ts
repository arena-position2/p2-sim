import type { Logger } from '@sim/logger'
import OpenAI from 'openai'
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions'
import type { StreamingExecution } from '@/executor/types'
import { MAX_TOOL_ITERATIONS } from '@/providers'
import { createReadableStreamFromOpenAIStream } from '@/providers/openai/utils'
import type {
  FunctionCallResponse,
  ProviderRequest,
  ProviderResponse,
  TimeSegment,
} from '@/providers/types'
import {
  calculateCost,
  isFunctionToolCall,
  prepareToolExecution,
  prepareToolsWithUsageControl,
  trackForcedToolUsage,
} from '@/providers/utils'
import { executeTool } from '@/tools'

/**
 * Recursively enforces strict JSON schema requirements for structured output.
 */
function enforceStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema

  const result = { ...schema }

  if (result.type === 'object') {
    result.additionalProperties = false

    if (result.properties && typeof result.properties === 'object') {
      const properties = result.properties as Record<string, unknown>
      const keys = Object.keys(properties)
      result.required = keys
      result.properties = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          enforceStrictSchema(value as Record<string, unknown>),
        ])
      )
    }
  }

  if (result.type === 'array' && result.items) {
    result.items = enforceStrictSchema(result.items as Record<string, unknown>)
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(result[keyword])) {
      result[keyword] = (result[keyword] as Record<string, unknown>[]).map(enforceStrictSchema)
    }
  }

  for (const defsKey of ['$defs', 'definitions']) {
    if (result[defsKey] && typeof result[defsKey] === 'object') {
      result[defsKey] = Object.fromEntries(
        Object.entries(result[defsKey] as Record<string, unknown>).map(([key, value]) => [
          key,
          enforceStrictSchema(value as Record<string, unknown>),
        ])
      )
    }
  }

  return result
}

export async function executeChatCompletionsProviderRequest(
  request: ProviderRequest,
  logger: Logger
): Promise<ProviderResponse | StreamingExecution> {
  const removeEmptyToolsConfig = (target: Record<string, unknown>): void => {
    const hasToolsArray = Array.isArray(target.tools)
    const toolsLength = hasToolsArray ? (target.tools as unknown[]).length : 0
    if (!hasToolsArray || toolsLength === 0) {
      target.tools = undefined
      target.tool_choice = undefined
      return
    }
    if (target.tool_choice === undefined) {
      target.tool_choice = undefined
    }
  }

  const openai = new OpenAI({ apiKey: request.apiKey })
  const allMessages = []

  if (request.systemPrompt) {
    allMessages.push({
      role: 'system',
      content: request.systemPrompt,
    })
  }

  if (request.context) {
    allMessages.push({
      role: 'user',
      content: request.context,
    })
  }

  if (request.messages) {
    allMessages.push(...request.messages)
  }

  const tools = request.tools?.length
    ? request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.id,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    : undefined

  const payload: Record<string, unknown> = {
    model: request.model,
    messages: allMessages,
  }

  if (request.temperature !== undefined) payload.temperature = request.temperature
  if (request.maxTokens !== undefined) payload.max_tokens = Number(request.maxTokens)
  if (request.reasoningEffort !== undefined) payload.reasoning_effort = request.reasoningEffort
  if (request.verbosity !== undefined) payload.verbosity = request.verbosity

  if (request.responseFormat) {
    const isStrict = request.responseFormat.strict !== false
    const rawSchema = request.responseFormat.schema || request.responseFormat
    const normalizedSchema = isStrict ? enforceStrictSchema(rawSchema) : rawSchema

    payload.response_format = {
      type: 'json_schema',
      json_schema: {
        name: request.responseFormat.name || 'response_schema',
        schema: normalizedSchema,
        strict: isStrict,
      },
    }
  }

  let preparedTools: ReturnType<typeof prepareToolsWithUsageControl> | null = null
  if (tools?.length) {
    preparedTools = prepareToolsWithUsageControl(tools, request.tools, logger, 'openai')
    const { tools: filteredTools, toolChoice } = preparedTools
    if (filteredTools?.length && toolChoice) {
      payload.tools = filteredTools
      payload.tool_choice = toolChoice
    }
  }
  removeEmptyToolsConfig(payload)

  const providerStartTime = Date.now()
  const providerStartTimeISO = new Date(providerStartTime).toISOString()

  try {
    if (request.stream && (!tools || tools.length === 0)) {
      const streamingParams: ChatCompletionCreateParamsStreaming = {
        ...(payload as Omit<ChatCompletionCreateParamsStreaming, 'stream'>),
        stream: true,
        stream_options: { include_usage: true },
      }
      const streamResponse = await openai.chat.completions.create(streamingParams)

      const streamingResult = {
        stream: createReadableStreamFromOpenAIStream(streamResponse, (content, usage) => {
          streamingResult.execution.output.content = content
          streamingResult.execution.output.tokens = {
            input: usage.prompt_tokens,
            output: usage.completion_tokens,
            total: usage.total_tokens,
          }
          const cost = calculateCost(request.model, usage.prompt_tokens, usage.completion_tokens)
          streamingResult.execution.output.cost = {
            input: cost.input,
            output: cost.output,
            total: cost.total,
          }
        }),
        execution: {
          success: true,
          output: {
            content: '',
            model: request.model,
            tokens: { input: 0, output: 0, total: 0 },
            cost: { input: 0, output: 0, total: 0 },
          },
          logs: [],
          metadata: {
            startTime: providerStartTimeISO,
            endTime: new Date().toISOString(),
            duration: Date.now() - providerStartTime,
          },
        },
      } as StreamingExecution

      return streamingResult
    }

    const initialCallTime = Date.now()
    const originalToolChoice = payload.tool_choice as
      | string
      | { type: string; function?: { name: string }; name?: string; any?: unknown }
      | undefined

    const forcedTools = preparedTools?.forcedTools || []
    let usedForcedTools: string[] = []
    let hasUsedForcedTool = false

    const checkForForcedToolUsage = (
      response: OpenAI.Chat.ChatCompletion,
      toolChoice:
        | string
        | { type: string; function?: { name: string }; name?: string; any?: unknown }
        | undefined
    ) => {
      if (typeof toolChoice !== 'object') {
        return
      }
      if (!response.choices[0]?.message?.tool_calls) {
        return
      }
      const result = trackForcedToolUsage(
        response.choices[0].message.tool_calls,
        toolChoice,
        logger,
        'openai',
        forcedTools,
        usedForcedTools
      )
      hasUsedForcedTool = result.hasUsedForcedTool
      usedForcedTools = result.usedForcedTools
    }

    let currentResponse = await openai.chat.completions.create(
      payload as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
    )
    const firstResponseTime = Date.now() - initialCallTime

    let content = currentResponse.choices[0]?.message?.content || ''
    const tokens = {
      input: currentResponse.usage?.prompt_tokens || 0,
      output: currentResponse.usage?.completion_tokens || 0,
      total: currentResponse.usage?.total_tokens || 0,
    }
    const toolCalls: FunctionCallResponse[] = []
    const toolResults: Array<Record<string, unknown>> = []
    const currentMessages = [...allMessages]
    let iterationCount = 0
    let modelTime = firstResponseTime
    let toolsTime = 0
    const timeSegments: TimeSegment[] = [
      {
        type: 'model',
        name: 'Initial response',
        startTime: initialCallTime,
        endTime: initialCallTime + firstResponseTime,
        duration: firstResponseTime,
      },
    ]

    checkForForcedToolUsage(currentResponse, originalToolChoice)

    while (iterationCount < MAX_TOOL_ITERATIONS) {
      if (currentResponse.choices[0]?.message?.content) {
        content = currentResponse.choices[0].message.content
      }

      const toolCallsInResponse = currentResponse.choices[0]?.message?.tool_calls
      if (!toolCallsInResponse || toolCallsInResponse.length === 0) {
        break
      }

      const toolsStartTime = Date.now()

      const toolExecutionPromises = toolCallsInResponse
        .filter(isFunctionToolCall)
        .map(async (toolCall) => {
          const toolCallStartTime = Date.now()
          const toolName = toolCall.function.name

          try {
            const toolArgs = JSON.parse(toolCall.function.arguments)
            const tool = request.tools?.find((t) => t.id === toolName)
            if (!tool) {
              return null
            }

            const { toolParams, executionParams } = prepareToolExecution(
              tool,
              toolArgs,
              request,
              toolCall.id
            )
            const result = await executeTool(toolName, executionParams)
            const toolCallEndTime = Date.now()

            return {
              toolCall,
              toolName,
              toolParams,
              result,
              startTime: toolCallStartTime,
              endTime: toolCallEndTime,
              duration: toolCallEndTime - toolCallStartTime,
            }
          } catch (error) {
            const toolCallEndTime = Date.now()
            logger.error('Error processing tool call:', { error, toolName })
            return {
              toolCall,
              toolName,
              toolParams: {},
              result: {
                success: false,
                output: undefined,
                error: error instanceof Error ? error.message : 'Tool execution failed',
              },
              startTime: toolCallStartTime,
              endTime: toolCallEndTime,
              duration: toolCallEndTime - toolCallStartTime,
            }
          }
        })

      const executionResults = await Promise.allSettled(toolExecutionPromises)

      currentMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: toolCallsInResponse.filter(isFunctionToolCall).map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      })

      for (const settledResult of executionResults) {
        if (settledResult.status === 'rejected' || !settledResult.value) {
          continue
        }
        const { toolCall, toolName, toolParams, result, startTime, endTime, duration } =
          settledResult.value

        timeSegments.push({
          type: 'tool',
          name: toolName,
          startTime,
          endTime,
          duration,
        })

        let resultContent: unknown
        if (result.success) {
          toolResults.push((result.output || {}) as Record<string, unknown>)
          resultContent = result.output
        } else {
          resultContent = {
            error: true,
            message: result.error || 'Tool execution failed',
            tool: toolName,
          }
        }

        toolCalls.push({
          name: toolName,
          arguments: toolParams,
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          duration,
          result:
            resultContent && typeof resultContent === 'object'
              ? (resultContent as Record<string, unknown>)
              : undefined,
        })

        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(resultContent),
        })
      }

      const thisToolsTime = Date.now() - toolsStartTime
      toolsTime += thisToolsTime

      const nextPayload: Record<string, unknown> = {
        ...payload,
        messages: currentMessages,
      }

      if (typeof originalToolChoice === 'object' && hasUsedForcedTool && forcedTools.length > 0) {
        const remainingTools = forcedTools.filter((tool) => !usedForcedTools.includes(tool))
        nextPayload.tool_choice =
          remainingTools.length > 0
            ? { type: 'function', function: { name: remainingTools[0] } }
            : 'auto'
      }
      removeEmptyToolsConfig(nextPayload)

      const nextModelStartTime = Date.now()
      currentResponse = await openai.chat.completions.create(
        nextPayload as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
      )
      checkForForcedToolUsage(currentResponse, nextPayload.tool_choice as typeof originalToolChoice)

      const nextModelEndTime = Date.now()
      const thisModelTime = nextModelEndTime - nextModelStartTime
      timeSegments.push({
        type: 'model',
        name: `Model response (iteration ${iterationCount + 1})`,
        startTime: nextModelStartTime,
        endTime: nextModelEndTime,
        duration: thisModelTime,
      })
      modelTime += thisModelTime

      if (currentResponse.usage) {
        tokens.input += currentResponse.usage.prompt_tokens || 0
        tokens.output += currentResponse.usage.completion_tokens || 0
        tokens.total += currentResponse.usage.total_tokens || 0
      }

      iterationCount++
    }

    if (request.stream) {
      const accumulatedCost = calculateCost(request.model, tokens.input, tokens.output)
      const streamingParams: ChatCompletionCreateParamsStreaming = {
        ...(payload as Omit<ChatCompletionCreateParamsStreaming, 'stream'>),
        messages: currentMessages as unknown as ChatCompletionCreateParamsStreaming['messages'],
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
      }
      removeEmptyToolsConfig(streamingParams as unknown as Record<string, unknown>)
      const streamResponse = await openai.chat.completions.create(streamingParams)

      const streamingResult = {
        stream: createReadableStreamFromOpenAIStream(streamResponse, (streamContent, usage) => {
          streamingResult.execution.output.content = streamContent
          streamingResult.execution.output.tokens = {
            input: tokens.input + usage.prompt_tokens,
            output: tokens.output + usage.completion_tokens,
            total: tokens.total + usage.total_tokens,
          }

          const streamCost = calculateCost(
            request.model,
            usage.prompt_tokens,
            usage.completion_tokens
          )
          streamingResult.execution.output.cost = {
            input: accumulatedCost.input + streamCost.input,
            output: accumulatedCost.output + streamCost.output,
            total: accumulatedCost.total + streamCost.total,
          }
        }),
        execution: {
          success: true,
          output: {
            content: '',
            model: request.model,
            tokens: {
              input: tokens.input,
              output: tokens.output,
              total: tokens.total,
            },
            toolCalls:
              toolCalls.length > 0
                ? {
                    list: toolCalls,
                    count: toolCalls.length,
                  }
                : undefined,
            providerTiming: {
              startTime: providerStartTimeISO,
              endTime: new Date().toISOString(),
              duration: Date.now() - providerStartTime,
              modelTime,
              toolsTime,
              firstResponseTime,
              iterations: iterationCount + 1,
              timeSegments,
            },
            cost: {
              input: accumulatedCost.input,
              output: accumulatedCost.output,
              total: accumulatedCost.total,
            },
          },
          logs: [],
          metadata: {
            startTime: providerStartTimeISO,
            endTime: new Date().toISOString(),
            duration: Date.now() - providerStartTime,
          },
        },
      } as StreamingExecution

      return streamingResult
    }

    const providerEndTime = Date.now()
    const providerEndTimeISO = new Date(providerEndTime).toISOString()
    const totalDuration = providerEndTime - providerStartTime

    return {
      content,
      model: request.model,
      tokens,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      timing: {
        startTime: providerStartTimeISO,
        endTime: providerEndTimeISO,
        duration: totalDuration,
        modelTime,
        toolsTime,
        firstResponseTime,
        iterations: iterationCount + 1,
        timeSegments,
      },
      cost: calculateCost(request.model, tokens.input, tokens.output),
    }
  } catch (error) {
    const providerEndTime = Date.now()
    const providerEndTimeISO = new Date(providerEndTime).toISOString()
    const totalDuration = providerEndTime - providerStartTime

    logger.error('Error in OpenAI chat-completions request', {
      error,
      duration: totalDuration,
    })

    const enhancedError = new Error(error instanceof Error ? error.message : String(error))
    ;(
      enhancedError as Error & { timing: { startTime: string; endTime: string; duration: number } }
    ).timing = {
      startTime: providerStartTimeISO,
      endTime: providerEndTimeISO,
      duration: totalDuration,
    }
    throw enhancedError
  }
}
